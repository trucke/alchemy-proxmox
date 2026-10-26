import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mockLayer } from "../../proxmox/test/helpers.ts";
import { deleteGuest, reconcileGuest } from "../src/Lifecycle.ts";

it.each(["lxc", "qemu"] as const)(
  "updates observed %s configuration and resizes without restart",
  async (kind) => {
    const disk = kind === "lxc" ? "rootfs" : "scsi0";
    const config: Record<string, unknown> = {
      tags: "alchemy;test",
      description: "old",
      [disk]: "store:vm-950-disk-0,size=2G",
      memory: kind === "lxc" ? 256 : "512",
      digest: "observed",
    };
    const writes: string[] = [];
    const layer = mockLayer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") {
        writes.push(path);
        const form = new URLSearchParams(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        expect(form.get("digest")).toBe("observed");
        if (path.endsWith("/resize")) {
          expect(form.get("size")).toBe("3G");
          config[disk] = "store:vm-950-disk-0,size=3G";
          return { body: { data: "UPID:resize" } };
        }
        expect(form.has(disk)).toBe(false);
        expect(form.has("tags")).toBe(false);
        config.description = form.get("description");
        return { body: { data: null } };
      }
      expect(request.method).toBe("GET");
      if (path.endsWith("/config")) return { body: { data: config } };
      if (path.endsWith("/pending")) return { body: { data: [] } };
      return { body: { data: { status: "stopped", exitstatus: "OK" } } };
    });
    const result = await Effect.runPromise(
      reconcileGuest(
        kind,
        {
          node: "pve",
          vmid: 950,
          config: { description: "new" },
          disks: { [disk]: { storage: "store", sizeGiB: 3 } },
        },
        ["alchemy", "test"],
      ).pipe(Effect.provide(layer)),
    );
    expect(result.config.description).toBe("new");
    expect(writes).toEqual([
      `/api2/json/nodes/pve/${kind}/950/config`,
      `/api2/json/nodes/pve/${kind}/950/resize`,
    ]);
  },
);
it.each(["lxc", "qemu"] as const)("stops and deletes %s without purge or force", async (kind) => {
  const writes: string[] = [];
  const layer = mockLayer((request) => {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      writes.push(request.method + " " + url.pathname);
      expect(url.searchParams.has("purge")).toBe(false);
      expect(url.searchParams.has("force")).toBe(false);
      if (request.method === "DELETE")
        expect(url.searchParams.get("destroy-unreferenced-disks")).toBe("1");
      return { body: { data: "UPID:test" } };
    }
    if (url.pathname.endsWith("/config"))
      return { body: { data: { protection: 0, tags: "alchemy;test" } } };
    if (url.pathname.endsWith("/pending")) return { body: { data: [] } };
    if (url.pathname.endsWith("/current")) return { body: { data: { status: "running" } } };
    return { body: { data: { status: "stopped", exitstatus: "OK" } } };
  });
  const output = { node: "pve", vmid: 950, config: { protection: 0 }, pending: [] };
  await Effect.runPromise(
    deleteGuest(kind, output, ["alchemy", "test"]).pipe(Effect.provide(layer)),
  );
  expect(writes).toEqual([
    `POST /api2/json/nodes/pve/${kind}/950/status/stop`,
    `DELETE /api2/json/nodes/pve/${kind}/950`,
  ]);
});
it("treats an absent guest as already deleted", async () => {
  const layer = mockLayer((request) => {
    expect(request.method).toBe("GET");
    return {
      status: 500,
      body: { data: null, message: "Configuration file 'nodes/pve/lxc/950.conf' does not exist\n" },
    };
  });
  await Effect.runPromise(
    deleteGuest("lxc", { node: "pve", vmid: 950 }, ["alchemy", "test"]).pipe(Effect.provide(layer)),
  );
});
it("refuses a guest without this stack's ownership tags and sends no write", async () => {
  const layer = mockLayer((request) => {
    expect(request.method).toBe("GET");
    if (request.url.includes("/pending")) return { body: { data: [] } };
    return { body: { data: { protection: 0, tags: "alchemy;other-stack;test" } } };
  });
  const error = await Effect.runPromise(
    deleteGuest("lxc", { node: "pve", vmid: 950 }, ["alchemy", "test-stack", "test"]).pipe(
      Effect.provide(layer),
      Effect.flip,
    ),
  );
  expect(error._tag).toBe("GuestNotOwned");
});
