import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { nodeLayer } from "@distilled.cloud/proxmox/node";
import * as Lxc from "@distilled.cloud/proxmox/services/nodes_lxc";
import * as Qemu from "@distilled.cloud/proxmox/services/nodes_qemu";
import * as Storage from "@distilled.cloud/proxmox/services/nodes_storage";
import { waitForTask } from "@distilled.cloud/proxmox/tasks";
import { deleteGuest, deleteGuestUnchecked, observe } from "../src/Lifecycle.ts";
import { waitForCloudInit } from "../src/CloudInit.ts";
import { DOWNLOAD_PREFIX, downloadSettings, guardedEndpoint, required, settings } from "./guard.ts";

const DOWNLOAD_STACK = "proxmox-download";

async function main() {
  const scope = settings();
  const download = downloadSettings();
  const proxy = await guardedEndpoint();
  const config = {
    endpoint: proxy.endpoint,
    caCert: proxy.ca,
    tokenId: Redacted.make(required("PROXMOX_TOKEN_ID")),
    tokenSecret: Redacted.make(required("PROXMOX_TOKEN_SECRET")),
  };
  const layer = nodeLayer(config);
  const run = <A, E>(
    effect: Effect.Effect<A, E, import("@distilled.cloud/proxmox/protocol").ProxmoxOpContext>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
  const identity = (vmid: number) => ({ node: scope.node, vmid });
  const secret = required("PROXMOX_TOKEN_SECRET");
  const token = required("PROXMOX_TOKEN_ID");
  const cli = (
    command: "plan" | "deploy" | "destroy",
    phase: string,
    stack = "proxmox-m3",
    adopt = true,
  ) =>
    new Promise<{ code: number; text: string }>((resolve, reject) => {
      const child = spawn(
        fileURLToPath(new URL("../node_modules/.bin/alchemy", import.meta.url)),
        [
          command,
          "--config",
          fileURLToPath(new URL("./stack.ts", import.meta.url)),
          "--stage",
          "test",
          ...(adopt && command !== "destroy" ? ["--adopt"] : []),
          "--no-input",
          ...(command === "plan" ? [] : ["--yes"]),
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: {
            ...process.env,
            CI: "true",
            PROXMOX_ENDPOINT: proxy.endpoint,
            PROXMOX_CA_CERT: proxy.ca,
            PROXMOX_TEST_PHASE: phase,
            PROXMOX_TEST_STACK: stack,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.stderr.on("data", (chunk) => {
        text += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const safe = text.replaceAll(secret, "[REDACTED]").replaceAll(token, "[REDACTED]");
        console.log(safe);
        resolve({ code: code ?? 1, text: safe });
      });
    });
  const members = async () => {
    const pool = await proxy.pool();
    assert(
      typeof pool === "object" && pool !== null && "members" in pool && Array.isArray(pool.members),
    );
    return pool.members.filter(
      (member): member is { vmid: number; type: "lxc" | "qemu"; node: string } =>
        typeof member === "object" &&
        member !== null &&
        "vmid" in member &&
        typeof member.vmid === "number" &&
        member.vmid >= scope.min &&
        member.vmid <= scope.max &&
        "type" in member &&
        (member.type === "lxc" || member.type === "qemu") &&
        "node" in member &&
        member.node === scope.node,
    );
  };
  /** Test-prefixed container templates on the download storage. */
  const testFiles = async () => {
    if (!download) return [];
    const volumes = await proxy.get(
      `/nodes/${encodeURIComponent(scope.node)}/storage/${encodeURIComponent(download.storage)}/content?content=vztmpl`,
    );
    assert(Array.isArray(volumes));
    return volumes.flatMap((volume) =>
      typeof volume === "object" &&
      volume !== null &&
      "volid" in volume &&
      typeof volume.volid === "string" &&
      volume.volid.startsWith(`${download.storage}:vztmpl/${DOWNLOAD_PREFIX}`)
        ? [volume.volid]
        : [],
    );
  };
  const cleanup = async () => {
    for (const guest of await members()) {
      // Membership is checked again at the proxy before every write. Protection is never overridden here.
      await run(deleteGuestUnchecked(guest.type, identity(guest.vmid)));
    }
    if (!download) return;
    for (const volume of await testFiles()) {
      // The proxy allows deleting only test-prefixed templates on the download storage.
      const request = { node: scope.node, storage: download.storage, volume };
      await run(
        Effect.flatMap(Storage.deleteNodesByNodeStorageByStorageContentByVolume(request), (upid) =>
          waitForTask(scope.node, upid),
        ),
      );
    }
  };
  const verifyEmpty = async () => {
    const pool = await proxy.pool();
    assert(
      typeof pool === "object" && pool !== null && "members" in pool && Array.isArray(pool.members),
    );
    assert.equal(pool.members.length, 0, "Pool is not empty");
    const volumes = await proxy.get(
      `/nodes/${encodeURIComponent(scope.node)}/storage/${encodeURIComponent(scope.storage)}/content`,
    );
    assert(Array.isArray(volumes));
    const leftovers = volumes.filter((volume) => {
      if (typeof volume !== "object" || volume === null) return false;
      if ("vmid" in volume && typeof volume.vmid === "number")
        return volume.vmid >= scope.min && volume.vmid <= scope.max;
      const match =
        "volid" in volume && typeof volume.volid === "string"
          ? /(?:vm-|subvol-)(\d+)-/.exec(volume.volid)
          : null;
      return match !== null && Number(match[1]) >= scope.min && Number(match[1]) <= scope.max;
    });
    assert.equal(leftovers.length, 0, "Test storage volumes remain");
    assert.equal((await testFiles()).length, 0, "Test downloads remain");
    console.log(
      `Cleanup GET evidence: pool members=0; allowed-range storage volumes=0; ${download ? "test downloads=0; " : ""}guarded writes=${proxy.writes()}`,
    );
  };
  let protectedGuest: { kind: "lxc" | "qemu"; vmid: number } | undefined;
  const setProtection = (kind: "lxc" | "qemu", vmid: number, protection: boolean) => {
    const request = { ...identity(vmid), protection };
    return run(
      kind === "lxc"
        ? Lxc.putNodesByNodeLxcByVmidConfig(request)
        : Qemu.putNodesByNodeQemuByVmidConfig(request),
    );
  };
  try {
    if (process.argv.includes("--cleanup")) {
      await cleanup();
    } else {
      assert.equal((await members()).length, 0, "Run cleanup before testing leftovers");
      if (download) {
        assert.equal((await testFiles()).length, 0, "Run cleanup before testing downloads");
        // Forget state from an interrupted run; its file is gone, so delete is a no-op.
        assert.equal((await cli("destroy", "download", DOWNLOAD_STACK)).code, 0);
        const created = await cli("deploy", "download", DOWNLOAD_STACK, false);
        assert.equal(created.code, 0, "Download failed");
        assert.deepEqual(await testFiles(), [download.volid], "Downloaded file is not listed");
        const changed = await cli("plan", "download-changed", DOWNLOAD_STACK, false);
        assert.notEqual(changed.code, 0);
        assert.match(changed.text, /UnsafeStorageDownloadChange/);
        assert.equal((await cli("destroy", "download", DOWNLOAD_STACK)).code, 0, "Destroy failed");
        assert.deepEqual(await testFiles(), [], "Downloaded file remains after destroy");
        console.log("Download checks passed: download, listing, changed-source plan, destroy");
      } else {
        console.log("Download phase skipped: PROXMOX_TEST_DOWNLOAD_* variables are not set");
      }
      // A prior finally block may have deleted cloud guests after a failed CLI run.
      // Forget their stale state before exercising a fresh create, not a cached noop.
      assert.equal((await cli("destroy", "retain")).code, 0, "Stale state cleanup failed");
      assert.equal((await cli("deploy", "retain")).code, 0, "Create failed");
      assert.equal(
        (await run(Lxc.getNodesByNodeLxcByVmidStatusCurrent(identity(scope.min)))).status,
        "running",
      );
      assert.equal(
        (await run(Qemu.getNodesByNodeQemuByVmidStatusCurrent(identity(scope.min + 1)))).status,
        "running",
      );
      await run(
        waitForCloudInit(identity(scope.min + 1)).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              console.log("Cloud-init and repeated-key command array verified live"),
            ),
          ),
          Effect.catchIf(
            (error) =>
              (error._tag === "InternalServerError" &&
                /guest agent.*not running/i.test(error.message ?? "")) ||
              (error._tag === "CloudInitFailed" && /Guest agent unavailable/.test(error.message)),
            () =>
              Effect.sync(() =>
                console.log(
                  "Cloud-init not verified live: guest agent unavailable in networkless image",
                ),
              ),
          ),
        ),
      );
      assert.equal((await cli("destroy", "retain")).code, 0, "Retain failed");
      assert.equal((await members()).length, 2, "Default retain must keep guests");
      await run(
        Lxc.putNodesByNodeLxcByVmidConfig({ ...identity(scope.min), delete: "tags,description" }),
      );
      await run(
        Qemu.putNodesByNodeQemuByVmidConfig({
          ...identity(scope.min + 1),
          delete: "tags,description",
        }),
      );
      for (const [kind, id] of [
        ["lxc", scope.min],
        ["qemu", scope.min + 1],
      ] as const) {
        const guest = await run(observe(kind, identity(id)));
        assert(
          guest && !guest.config.tags && !guest.config.description,
          "Multi-value delete must remove both fields",
        );
      }
      console.log(
        "Wire evidence: multi-value delete removed tags and description for both guest types",
      );
      await run(
        Lxc.putNodesByNodeLxcByVmidConfig({ ...identity(scope.min), description: "created" }),
      );
      await run(
        Qemu.putNodesByNodeQemuByVmidConfig({ ...identity(scope.min + 1), description: "created" }),
      );
      const unowned = await cli("plan", "create", "proxmox-m3", false);
      assert.notEqual(unowned.code, 0);
      assert.match(unowned.text, /OwnedBySomeoneElse/);
      assert.match(unowned.text, /--adopt/);
      assert.match(unowned.text, /interrupted before tagging/);
      const beforeCt = await run(observe("lxc", identity(scope.min)));
      const beforeVm = await run(observe("qemu", identity(scope.min + 1)));
      const forbidden = await cli("plan", "forbidden");
      assert.notEqual(forbidden.code, 0);
      assert.match(forbidden.text, /UnsafeGuestChange/);
      assert.doesNotMatch(forbidden.text, /UnknownError: An error occurred in Effect.try/);
      const invalid = await cli("plan", "create", "invalid name");
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.text, /InvalidOwnershipName/);
      assert.equal((await cli("deploy", "create")).code, 0, "Adoption failed");
      const withoutTags = (value: Awaited<ReturnType<typeof observeResult>>) => {
        assert(value);
        const { tags: _, digest: __, ...rest } = value.config;
        return rest;
      };
      assert.deepEqual(
        withoutTags(await run(observe("lxc", identity(scope.min)))),
        withoutTags(beforeCt),
      );
      assert.deepEqual(
        withoutTags(await run(observe("qemu", identity(scope.min + 1)))),
        withoutTags(beforeVm),
      );
      assert.equal((await cli("deploy", "update")).code, 0, "Update failed");
      const ct = await run(observe("lxc", identity(scope.min)));
      const vm = await run(observe("qemu", identity(scope.min + 1)));
      assert(ct && vm);
      assert.equal(String(ct.config.description).trimEnd(), "updated");
      assert.equal(ct.config.memory, 512);
      assert.match(String(ct.config.rootfs), /size=3G/);
      assert.equal(String(vm.config.description).trimEnd(), "updated");
      assert.match(String(vm.config.scsi0), /size=5G/);
      assert(
        vm.pending.some((item) => item.key === "memory"),
        "VM memory must remain pending without reboot",
      );
      for (const [kind, vmid] of [
        ["lxc", scope.min],
        ["qemu", scope.min + 1],
      ] as const) {
        protectedGuest = { kind, vmid };
        await setProtection(kind, vmid, true);
        const protectedDelete = await run(
          deleteGuestUnchecked(kind, identity(vmid)).pipe(Effect.flip),
        );
        assert.equal(protectedDelete._tag, "GuestProtected");
        assert.match(protectedDelete.message ?? "", /protected/);
        await setProtection(kind, vmid, false);
        protectedGuest = undefined;
      }
      assert.equal((await cli("destroy", "update")).code, 0, "Destroy failed");
      const liveOwner = ["alchemy", "proxmox-m3", "test"];
      await run(deleteGuest("lxc", identity(scope.min), liveOwner));
      await run(deleteGuest("qemu", identity(scope.min + 1), liveOwner));
      console.log(
        "Live checks passed: create/start, retain, typed plans, tag-only adoption, live update, pending memory, disk growth, protection, destroy, missing delete",
      );
    }
  } finally {
    try {
      if (protectedGuest) await setProtection(protectedGuest.kind, protectedGuest.vmid, false);
      await cleanup();
      await verifyEmpty();
    } finally {
      await proxy.close();
    }
  }
  function observeResult() {
    return run(observe("lxc", identity(scope.min)));
  }
}
main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : "Live suite failed";
  for (const key of ["PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]) {
    const value = process.env[key];
    if (value) message = message.replaceAll(value, "[REDACTED]");
  }
  console.error(message);
  process.exitCode = 1;
});
