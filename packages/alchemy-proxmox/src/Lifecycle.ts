import * as Lxc from "@distilled.cloud/proxmox/services/nodes_lxc";
import * as Qemu from "@distilled.cloud/proxmox/services/nodes_qemu";
import { waitForTask } from "@distilled.cloud/proxmox/tasks";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toEffect } from "@distilled.cloud/core/schema-lite";

import { codecsFor, normalizeConfig, record, type GuestKind } from "./Config.ts";
import {
  planChanges,
  GuestPlanFailed,
  type GuestAttributes,
  type GuestDeclaration,
} from "./Changes.ts";
import { mergeTags, ownership } from "./Tags.ts";
import { waitForCloudInit } from "./CloudInit.ts";

/** Generated schemas use distilled's lightweight AST, not Effect's runtime AST. */
const decodeRequest = <A>(schema: Schema.Schema<A>) => {
  // toEffect preserves the generated request shape but intentionally returns unknown.
  const runtime = toEffect(Schema, schema.ast as Parameters<typeof toEffect>[1]) as Schema.Codec<A>;
  return Schema.decodeUnknownEffect(runtime);
};

export interface CreateDeclaration extends GuestDeclaration {
  pool?: string;
  /** Applies only when creating a guest. Existing guests are never restarted. */
  startAfterCreate?: boolean;
  waitForCloudInit?: boolean;
  cloudInitStorage?: string;
  template?: string;
  image?: string;
  sshKeys?: string[];
}
export class GuestTaggingFailed extends Data.TaggedError("GuestTaggingFailed")<{
  message: string;
}> {}
export class GuestProtected extends Data.TaggedError("GuestProtected")<{ message: string }> {}
export class GuestNotOwned extends Data.TaggedError("GuestNotOwned")<{ message: string }> {}
export class GuestNotResolved extends Data.TaggedError("GuestNotResolved")<{ message: string }> {}

export const observe = Effect.fn(function* (
  kind: GuestKind,
  guest: { node: string; vmid: number },
) {
  const identity = { node: guest.node, vmid: guest.vmid };
  return yield* Effect.gen(function* () {
    const config =
      kind === "lxc"
        ? yield* Lxc.getNodesByNodeLxcByVmidConfig(identity)
        : yield* Qemu.getNodesByNodeQemuByVmidConfig(identity);
    const pending =
      kind === "lxc"
        ? yield* Lxc.getNodesByNodeLxcByVmidPending(identity)
        : yield* Qemu.getNodesByNodeQemuByVmidPending(identity);
    const safe: Record<string, unknown> = { ...config };
    delete safe.cipassword;
    return {
      ...identity,
      config: safe,
      pending: pending.filter(
        (item) => item.key !== "cipassword" && (item.pending !== undefined || item.delete),
      ),
    } satisfies GuestAttributes;
  }).pipe(Effect.catchTag("GuestNotFound", () => Effect.succeed(undefined)));
});

/** Merge declared leaves into observed property strings, preserving generated MACs and volume IDs. */
export function wireConfig(
  kind: GuestKind,
  config: object,
  observed: Record<string, unknown> = {},
) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const desired = normalizeConfig(kind, key, value);
    const previous = normalizeConfig(kind, key, observed[key]);
    if (!record(desired)) {
      result[key] = desired;
      continue;
    }
    const merged = { ...(record(previous) ? previous : {}), ...desired };
    const codec = codecsFor(kind)[key] ?? codecsFor(kind)[key.replace(/\d+$/, "[n]")];
    const defaultKey = codec
      ? Object.keys(codec.format).find((k) => codec.format[k].default_key)
      : "$";
    const encoded = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a === defaultKey ? -1 : b === defaultKey ? 1 : a.localeCompare(b)))
      .map(([k, v]) => {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
          throw new Error("Expected scalar property");
        const text = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
        if (text.includes(",") || (k === defaultKey && text.includes("=")))
          throw new Error("Ambiguous property delimiter");
        return k === defaultKey ? text : `${k}=${text}`;
      })
      .join(",");
    if (codec) codec.decode(encoded);
    result[key] = encoded;
  }
  return result;
}
const buildConfig = (kind: GuestKind, config: object, observed?: Record<string, unknown>) =>
  Effect.try({
    try: () => wireConfig(kind, config, observed),
    catch: () => new GuestPlanFailed({ message: "Invalid Proxmox configuration" }),
  });
const awaitTask = Effect.fn(function* (node: string, upid: string) {
  const task = yield* waitForTask(node, upid);
  if (task.warnings)
    yield* Effect.logWarning(`Proxmox task completed with ${task.warnings} warnings`);
});

export const reconcileGuest = Effect.fn(function* (
  kind: GuestKind,
  news: CreateDeclaration,
  owner: readonly string[],
) {
  if (news.waitForCloudInit && news.startAfterCreate === false)
    return yield* new GuestPlanFailed({ message: "waitForCloudInit requires startAfterCreate" });
  const identity = { node: news.node, vmid: news.vmid };
  let current = yield* observe(kind, identity);
  const creating = current === undefined;
  if (!current) {
    if (!news.pool)
      return yield* new GuestPlanFailed({ message: "Creating a Proxmox guest requires pool" });
    const declaration: Record<string, unknown> = { ...news.config };
    for (const [key, disk] of Object.entries(news.disks ?? {})) {
      if (!disk) continue;
      const options = normalizeConfig(kind, key, declaration[key]);
      const volume = kind === "lxc" ? "volume" : "file";
      const importing = kind === "qemu" && news.image && key === "scsi0";
      if (
        (!importing && disk.sizeGiB === undefined) ||
        (disk.sizeGiB !== undefined && (!Number.isFinite(disk.sizeGiB) || disk.sizeGiB <= 0))
      ) {
        return yield* new GuestPlanFailed({
          message: `Creating disk ${key} requires a positive sizeGiB (optional for an imported image)`,
        });
      }
      const properties = {
        ...(record(options) ? options : {}),
        [volume]: `${disk.storage}:${importing ? 0 : disk.sizeGiB}`,
      };
      if (kind === "qemu" && news.image && key === "scsi0")
        Object.assign(properties, { "import-from": news.image });
      delete properties.size;
      declaration[key] = properties;
    }
    if (kind === "qemu" && news.cloudInitStorage) {
      if (declaration.ide2 !== undefined)
        return yield* new GuestPlanFailed({
          message: "cloudInitStorage and config.ide2 cannot both be declared",
        });
      declaration.ide2 = `${news.cloudInitStorage}:cloudinit`;
    }
    const config = yield* buildConfig(kind, declaration);
    // Proxmox's tag permission check ignores the requested creation pool.
    // Use the same untagged-create path for every token, then tag the pool member.
    const tags = mergeTags(
      undefined,
      typeof config.tags === "string" ? config.tags : undefined,
      owner,
    );
    delete config.tags;
    const input = { ...config, ...identity, pool: news.pool, start: false };
    if (kind === "lxc") {
      if (!news.template)
        return yield* new GuestPlanFailed({ message: "Creating a container requires template" });
      const request = yield* decodeRequest(Lxc.PostNodesByNodeLxcRequest)({
        ...input,
        ostemplate: news.template,
        "ssh-public-keys": news.sshKeys?.join("\n"),
      });
      yield* awaitTask(news.node, yield* Lxc.postNodesByNodeLxc(request));
    } else {
      if (news.image && !news.disks?.scsi0)
        return yield* new GuestPlanFailed({ message: "VM image import requires disks.scsi0" });
      const request = yield* decodeRequest(Qemu.PostNodesByNodeQemuRequest)({
        ...input,
        sshkeys: news.sshKeys ? encodeURIComponent(news.sshKeys.join("\n")) : undefined,
      });
      yield* awaitTask(news.node, yield* Qemu.postNodesByNodeQemu(request));
    }
    const tagRequest = { ...identity, tags };
    yield* (
      kind === "lxc"
        ? Lxc.putNodesByNodeLxcByVmidConfig(tagRequest)
        : Qemu.putNodesByNodeQemuByVmidConfig(tagRequest)
    ).pipe(
      Effect.mapError(
        (error) =>
          new GuestTaggingFailed({
            message: `Guest ${news.vmid} was created in pool ${news.pool}, but tagging failed (${error._tag}). It remains unowned. Match the declaration to the observed guest and rerun with --adopt; adoption only adds ownership tags and never starts or resizes the guest.`,
          }),
      ),
    );
    current = yield* observe(kind, identity);
  }
  if (!current)
    return yield* new GuestNotResolved({ message: "Proxmox guest was not found after creation" });
  const deltas = yield* planChanges(
    kind,
    creating ? { ...identity, disks: news.disks } : news,
    current,
    owner,
  );
  const config: Record<string, unknown> = {};
  const resizes: { disk: string; size: string }[] = [];
  const desired = yield* buildConfig(kind, news.config ?? {}, current.config);
  for (const delta of deltas) {
    const [key, field] = delta.path.split(".");
    if (
      (field === "sizeGiB" || field === "size") &&
      /^(rootfs|mp\d+|scsi\d+|ide\d+|sata\d+|virtio\d+)$/.test(key)
    ) {
      const size = Number(delta.declared) / (field === "size" ? 1024 ** 3 : 1);
      resizes.push({ disk: key, size: `${size}G` });
    } else config[key] = key === "tags" ? delta.declared : desired[key];
  }
  if (Object.keys(config).length) {
    const digest = typeof current.config.digest === "string" ? current.config.digest : undefined;
    if (kind === "lxc")
      yield* Lxc.putNodesByNodeLxcByVmidConfig(
        yield* decodeRequest(Lxc.PutNodesByNodeLxcByVmidConfigRequest)({
          ...config,
          ...identity,
          digest,
        }),
      );
    else
      yield* Qemu.putNodesByNodeQemuByVmidConfig(
        yield* decodeRequest(Qemu.PutNodesByNodeQemuByVmidConfigRequest)({
          ...config,
          ...identity,
          digest,
        }),
      );
  }
  for (const resize of resizes) {
    const refreshed = yield* observe(kind, identity);
    if (!refreshed)
      return yield* new GuestNotResolved({ message: "Proxmox guest disappeared before resize" });
    const digest =
      typeof refreshed.config.digest === "string" ? refreshed.config.digest : undefined;
    const request = { ...identity, ...resize, digest };
    yield* awaitTask(
      news.node,
      kind === "lxc"
        ? yield* Lxc.putNodesByNodeLxcByVmidResize(request)
        : yield* Qemu.putNodesByNodeQemuByVmidResize(request),
    );
  }
  if (creating && news.startAfterCreate !== false) {
    yield* awaitTask(
      news.node,
      kind === "lxc"
        ? yield* Lxc.postNodesByNodeLxcByVmidStatusStart(identity)
        : yield* Qemu.postNodesByNodeQemuByVmidStatusStart(identity),
    );
  }
  if (creating && kind === "qemu" && news.waitForCloudInit) yield* waitForCloudInit(identity);
  const observed = yield* observe(kind, identity);
  if (!observed)
    return yield* new GuestNotResolved({
      message: "Proxmox guest disappeared after reconciliation",
    });
  for (const pending of observed.pending)
    yield* Effect.logInfo(
      `Proxmox ${news.vmid}: ${pending.key} has a pending change; no reboot will be performed`,
    );
  return observed;
});

/**
 * Protection check, stop and delete of an observed guest. Callers decide whether ownership must be
 * checked first.
 */
const destroyObserved = Effect.fn(function* (
  kind: GuestKind,
  identity: { node: string; vmid: number },
  current: GuestAttributes,
) {
  if (current.config.protection)
    return yield* new GuestProtected({
      message: `Proxmox guest ${identity.vmid} is protected; remove protection explicitly before destroying it`,
    });
  const status =
    kind === "lxc"
      ? yield* Lxc.getNodesByNodeLxcByVmidStatusCurrent(identity)
      : yield* Qemu.getNodesByNodeQemuByVmidStatusCurrent(identity);
  if (status.status !== "stopped")
    yield* awaitTask(
      identity.node,
      kind === "lxc"
        ? yield* Lxc.postNodesByNodeLxcByVmidStatusStop(identity)
        : yield* Qemu.postNodesByNodeQemuByVmidStatusStop(identity),
    );
  const request = { ...identity, "destroy-unreferenced-disks": true };
  yield* awaitTask(
    identity.node,
    kind === "lxc"
      ? yield* Lxc.deleteNodesByNodeLxcByVmid(request)
      : yield* Qemu.deleteNodesByNodeQemuByVmid(request),
  );
});

/**
 * Alchemy calls delete only for RemovalPolicy.destroy; retain skips the provider entirely.
 * Proxmox reuses VMIDs, so the guest must still carry this stack's ownership tags: a different
 * guest created later under the same VMID is never deleted.
 */
export const deleteGuest = Effect.fn(function* (
  kind: GuestKind,
  guest: { node: string; vmid: number },
  owner: readonly string[],
) {
  // Alchemy passes full attributes. Project identity before crossing the API boundary.
  const identity = { node: guest.node, vmid: guest.vmid };
  yield* Effect.gen(function* () {
    const current = yield* observe(kind, identity);
    if (!current) return;
    const tags = typeof current.config.tags === "string" ? current.config.tags : undefined;
    if (ownership(tags, owner) !== "owned")
      return yield* new GuestNotOwned({
        message: `Proxmox guest ${identity.vmid} does not carry this stack's ownership tags (${owner.join(", ")}). It may be a different guest that reuses the VMID; nothing was deleted.`,
      });
    yield* destroyObserved(kind, identity, current);
  }).pipe(Effect.catchTag("GuestNotFound", () => Effect.void));
});

/**
 * Deletes without the ownership check. Only for test-pool cleanup of guests whose tagging was
 * interrupted; the live-test guard limits it to the test pool and VMID range.
 */
export const deleteGuestUnchecked = Effect.fn(function* (
  kind: GuestKind,
  guest: { node: string; vmid: number },
) {
  const identity = { node: guest.node, vmid: guest.vmid };
  yield* Effect.gen(function* () {
    const current = yield* observe(kind, identity);
    if (current) yield* destroyObserved(kind, identity, current);
  }).pipe(Effect.catchTag("GuestNotFound", () => Effect.void));
});
