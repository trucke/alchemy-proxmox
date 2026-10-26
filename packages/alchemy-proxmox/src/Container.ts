import {
  getNodesByNodeLxcByVmidConfig,
  getNodesByNodeLxcByVmidPending,
  type PutNodesByNodeLxcByVmidConfigRequest,
} from "@distilled.cloud/proxmox/services/nodes_lxc";
import { nodeLayer } from "@distilled.cloud/proxmox/node";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { containerCodecs, type StructuredConfig } from "./Config.ts";
import { planChanges, GuestReadFailed, type Disk, type GuestAttributes } from "./Changes.ts";
import { ProxmoxEnvironment } from "./Environment.ts";
import { createOwnershipTags, ownership } from "./Tags.ts";
import { reconcileGuest, deleteGuest } from "./Lifecycle.ts";

export interface ContainerProps {
  /** Required when creating. Existing guests are never moved between pools. */
  pool?: string;
  /** Start after creation (default true). Never changes an existing guest's power state. */
  startAfterCreate?: boolean;
  /** Existing Proxmox node. Changing nodes is forbidden. */
  node: string;
  /** Explicit guest ID. Never automatically allocated. */
  vmid: number;
  /** Compare only declared config fields and structured property-string keys. */
  config?: StructuredConfig<
    Omit<PutNodesByNodeLxcByVmidConfigRequest, "node" | "vmid" | "digest" | "delete" | "revert">,
    typeof containerCodecs
  >;
  /** Disk storage and capacity, independent of generated volume names. */
  disks?: Partial<Record<"rootfs" | `mp${number}`, Disk>>;
  /** Create-only template reference, not compared with an existing guest. */
  template?: string;
  /** Create-only initial public keys, not compared after creation. */
  sshKeys?: string[];
}
export type Container = Resource<
  "Proxmox.Container",
  ContainerProps,
  GuestAttributes,
  never,
  import("./Providers.ts").Providers
>;
/**
 * Manage an LXC container, retaining it by default.
 *
 * ### Adopt an existing container
 * **Example:** Explicit identity and declared config
 * ```typescript
 * const guest = yield* Container("web", {
 *   node: "pve", vmid: 100,
 *   config: { hostname: "web", net0: { name: "eth0", ip: "dhcp" } },
 * });
 * ```
 * @resource
 */
export const Container = Resource<Container>("Proxmox.Container", {
  defaultRemovalPolicy: "retain",
});
export const ContainerProvider = () =>
  Provider.succeed(Container, {
    stables: ["node", "vmid"],
    read: Effect.fn(function* ({ fqn, olds, output }) {
      const owner = yield* createOwnershipTags(fqn);
      const identity = output ?? olds;
      const environment = yield* ProxmoxEnvironment.current;
      const found = yield* Effect.gen(function* () {
        const config = yield* getNodesByNodeLxcByVmidConfig({
          node: identity.node,
          vmid: identity.vmid,
        });
        const pending = yield* getNodesByNodeLxcByVmidPending({
          node: identity.node,
          vmid: identity.vmid,
        });
        return {
          node: identity.node,
          vmid: identity.vmid,
          config: { ...config },
          pending: pending.filter((item) => item.pending !== undefined || item.delete),
        };
      }).pipe(
        Effect.catchTag("GuestNotFound", () => Effect.succeed(undefined)),
        Effect.mapError(
          (error) =>
            new GuestReadFailed({ message: `Proxmox container read failed (${error._tag})` }),
        ),
        Effect.provide(nodeLayer(environment)),
      );
      if (!found) return undefined;
      if (ownership(found.config.tags, owner) === "owned") return found;
      yield* Effect.logWarning(
        `Proxmox ${fqn} is unowned. Creation may have been interrupted before tagging. Match the declaration to the observed guest and rerun with --adopt; adoption only adds ownership tags.`,
      );
      return Unowned(found);
    }),
    diff: Effect.fn(function* ({ fqn, news, output }) {
      if (!isResolved(news) || !output) return;
      const owner = yield* createOwnershipTags(fqn);
      for (const pending of output.pending)
        yield* Effect.logInfo(
          `Proxmox ${fqn}: ${pending.key} has a pending change; no reboot will be performed`,
        );
      const deltas = yield* planChanges("lxc", news, output, owner);
      for (const delta of deltas)
        yield* Effect.logInfo(
          `Proxmox ${fqn}: ${delta.path} (${delta.classification}) ${JSON.stringify(delta.live)} -> ${JSON.stringify(delta.declared)}`,
        );
      return { action: deltas.length ? "update" : "noop" } as const;
    }),
    reconcile: Effect.fn(function* ({ fqn, news }) {
      const environment = yield* ProxmoxEnvironment.current;
      const owner = yield* createOwnershipTags(fqn);
      return yield* reconcileGuest("lxc", news, owner).pipe(Effect.provide(nodeLayer(environment)));
    }),
    delete: Effect.fn(function* ({ fqn, output }) {
      const environment = yield* ProxmoxEnvironment.current;
      const owner = yield* createOwnershipTags(fqn);
      yield* deleteGuest("lxc", output, owner).pipe(Effect.provide(nodeLayer(environment)));
    }),
  });
