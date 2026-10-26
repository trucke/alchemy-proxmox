import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mockLayer } from "../../proxmox/test/helpers.ts";
import { reconcileGuest } from "../src/Lifecycle.ts";

it.each(["lxc", "qemu"] as const)(
  "creates %s stopped in its pool before starting",
  async (kind) => {
    let exists = false;
    let tags: string | undefined;
    const disk = kind === "lxc" ? "rootfs" : "scsi0";
    const writes: { path: string; form: URLSearchParams }[] = [];
    const layer = mockLayer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") {
        const form = new URLSearchParams(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        writes.push({ path, form });
        exists = true;
        if (request.method === "PUT") {
          tags = form.get("tags") ?? undefined;
          return { body: { data: null } };
        }
        return { body: { data: "UPID:test" } };
      }
      if (path.endsWith("/config"))
        return exists
          ? { body: { data: { tags, [disk]: "store:vm-950-disk-0,size=3G" } } }
          : {
              status: 500,
              body: {
                data: null,
                message: `Configuration file 'nodes/pve/${kind === "lxc" ? "lxc" : "qemu-server"}/950.conf' does not exist\n`,
              },
            };
      if (path.endsWith("/pending")) return { body: { data: [] } };
      return { body: { data: { status: "stopped", exitstatus: "OK" } } };
    });
    await Effect.runPromise(
      reconcileGuest(
        kind,
        {
          node: "pve",
          vmid: 950,
          pool: "test",
          template: "local:template",
          config: { tags: "user" },
          image: kind === "qemu" ? "local:import/image.qcow2" : undefined,
          disks: { [disk]: { storage: "store", sizeGiB: 3 } },
        },
        ["alchemy", "test"],
      ).pipe(Effect.provide(layer)),
    );
    expect(writes).toHaveLength(3);
    expect(writes[0].form.get("pool")).toBe("test");
    expect(writes[0].form.get("start")).toBe("0");
    expect(writes[0].form.has("tags")).toBe(false);
    expect(writes[1].form.get("tags")).toBe("user;alchemy;test");
    expect(writes[0].form.get(disk)).toBe(
      kind === "lxc" ? "store:3" : "store:0,import-from=local:import/image.qcow2",
    );
    expect(writes[1].path).toMatch(/\/config$/);
    expect(writes[2].path).toMatch(/\/status\/start$/);
  },
);
