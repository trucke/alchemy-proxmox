import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mockLayer } from "../../proxmox/test/helpers.ts";
import { reconcileGuest, observe } from "../src/Lifecycle.ts";
import { ownership } from "../src/Tags.ts";
import { planChanges } from "../src/Changes.ts";

it.each(["lxc", "qemu"] as const)(
  "leaves interrupted %s creation unowned and recovers with tags only",
  async (kind) => {
    let exists = false;
    let rejectTags = true;
    let tags: string | undefined;
    const writes: string[] = [];
    const identity = { node: "pve", vmid: 950 };
    const owner = ["alchemy", "test"];
    const layer = mockLayer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        writes.push(path);
        exists = true;
        return { body: { data: "UPID:create" } };
      }
      if (request.method === "PUT") {
        writes.push(path);
        if (rejectTags)
          return { status: 403, body: { data: null, message: "Tag write interrupted" } };
        const form = new URLSearchParams(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        expect([...form.keys()]).toEqual(["tags"]);
        tags = form.get("tags") ?? undefined;
        return { body: { data: null } };
      }
      if (path.endsWith("/config"))
        return exists
          ? { body: { data: { tags } } }
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
    const props = { ...identity, pool: "test", template: "local:template" };
    const failure = await Effect.runPromise(
      reconcileGuest(kind, props, owner).pipe(Effect.provide(layer), Effect.flip),
    );
    expect(failure).toMatchObject({
      _tag: "GuestTaggingFailed",
      message: expect.stringContaining("rerun with --adopt"),
    });
    const found = await Effect.runPromise(observe(kind, identity).pipe(Effect.provide(layer)));
    expect(found).toBeDefined();
    expect(ownership(tags, owner)).toBe("unmanaged");
    if (!found) throw new Error("Expected created guest");
    expect(await Effect.runPromise(planChanges(kind, props, found, owner))).toEqual([
      { path: "tags", declared: "alchemy;test", live: undefined, classification: "live" },
    ]);
    rejectTags = false;
    writes.length = 0;
    await Effect.runPromise(reconcileGuest(kind, props, owner).pipe(Effect.provide(layer)));
    expect(writes).toEqual([`/api2/json/nodes/pve/${kind}/950/config`]);
  },
);
