import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mockLayer } from "../../proxmox/test/helpers.ts";
import { deleteGuest, wireConfig } from "../src/Lifecycle.ts";
import { waitForCloudInit } from "../src/CloudInit.ts";
import { planChanges } from "../src/Changes.ts";

it("merges partial property strings without losing generated identity", () => {
  expect(
    wireConfig(
      "qemu",
      { net0: { firewall: true } },
      { net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=0" },
    ),
  ).toEqual({ net0: "virtio,bridge=vmbr0,firewall=1,macaddr=AA:BB:CC:DD:EE:FF" });
  expect(wireConfig("qemu", { memory: { current: 768 } }, { memory: "512" })).toEqual({
    memory: "768",
  });
});
it("ignores the description newline added by Proxmox configuration comments", async () => {
  expect(
    await Effect.runPromise(
      planChanges(
        "lxc",
        { node: "pve", vmid: 100, config: { description: "created" } },
        {
          node: "pve",
          vmid: 100,
          config: { description: "created\n", tags: "alchemy;test" },
          pending: [],
        },
        ["alchemy", "test"],
      ),
    ),
  ).toEqual([]);
});
it("keeps unsafe changes in the typed failure channel", async () => {
  const error = await Effect.runPromise(
    planChanges(
      "lxc",
      { node: "pve", vmid: 100, config: { ostype: "alpine" } },
      { node: "pve", vmid: 100, config: { tags: "alchemy;test", ostype: "debian" }, pending: [] },
      ["alchemy", "test"],
    ).pipe(Effect.flip),
  );
  expect(error._tag).toBe("UnsafeGuestChange");
});
it("refuses protection without sending a write", async () => {
  const layer = mockLayer((request) => {
    expect(request.method).toBe("GET");
    return {
      body: {
        data: request.url.includes("/pending") ? [] : { protection: 1, tags: "alchemy;test" },
      },
    };
  });
  const error = await Effect.runPromise(
    deleteGuest("qemu", { node: "pve", vmid: 100 }, ["alchemy", "test"]).pipe(
      Effect.provide(layer),
      Effect.flip,
    ),
  );
  expect(error._tag).toBe("GuestProtected");
});
it("cloud-init executes once and accepts a successful exit", async () => {
  const commands: string[][] = [];
  const layer = mockLayer((request) => {
    if (request.url.includes("exec-status")) return { body: { data: { exited: 1, exitcode: 0 } } };
    if (request.url.endsWith("/ping")) return { body: { data: {} } };
    expect(request.body._tag).toBe("Uint8Array");
    if (request.body._tag === "Uint8Array")
      commands.push(
        new URLSearchParams(new TextDecoder().decode(request.body.body)).getAll("command"),
      );
    return { body: { data: { pid: 42 } } };
  });
  await Effect.runPromise(waitForCloudInit({ node: "pve", vmid: 100 }).pipe(Effect.provide(layer)));
  expect(commands).toEqual([["cloud-init", "status", "--wait"]]);
});
it.each([
  { exited: true, exitcode: 1 },
  { exited: 1, signal: 9 },
  { exited: 1, exitcode: 2 },
])("cloud-init rejects abnormal completion %j", async (status) => {
  const layer = mockLayer((request) => ({
    body: {
      data: request.url.includes("exec-status")
        ? status
        : request.url.endsWith("/ping")
          ? {}
          : { pid: 42 },
    },
  }));
  const error = await Effect.runPromise(
    waitForCloudInit({ node: "pve", vmid: 100 }).pipe(Effect.provide(layer), Effect.flip),
  );
  expect(error._tag).toBe("CloudInitFailed");
});
