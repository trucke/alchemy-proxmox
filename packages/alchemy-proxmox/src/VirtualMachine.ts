import {
  getNodesByNodeQemuByVmidConfig,
  getNodesByNodeQemuByVmidPending,
  type PutNodesByNodeQemuByVmidConfigRequest,
} from "@distilled.cloud/proxmox/services/nodes_qemu";
import { nodeLayer } from "@distilled.cloud/proxmox/node";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { virtualMachineCodecs, type StructuredConfig } from "./Config.ts";
import { planChanges, GuestReadFailed, type Disk, type GuestAttributes } from "./Changes.ts";
import { ProxmoxEnvironment } from "./Environment.ts";
import { createOwnershipTags, ownership } from "./Tags.ts";
import { reconcileGuest, deleteGuest } from "./Lifecycle.ts";

export interface VirtualMachineProps {
  /** Required when creating. Existing guests are never moved between pools. */
  pool?: string;
  /** Start after creation (default true). Never changes an existing guest's power state. */
  startAfterCreate?: boolean;
  /** Wait for cloud-init through the guest agent after creation. Requires startAfterCreate. */
  waitForCloudInit?: boolean;
  /** Create-only storage for an ide2 cloud-init drive. Do not also declare config.ide2. */
  cloudInitStorage?: string;
  /** Existing Proxmox node. Changing nodes is forbidden. */
  node: string;
  /** Explicit guest ID. Never automatically allocated. */
  vmid: number;
  /** Compare only declared config fields and structured property-string keys. */
  config?: StructuredConfig<
    Omit<
      PutNodesByNodeQemuByVmidConfigRequest,
      "node" | "vmid" | "digest" | "delete" | "revert" | "cipassword" | "sshkeys"
    >,
    typeof virtualMachineCodecs
  >;
  /** Disk storage and capacity, independent of generated volume names. */
  disks?: Partial<
    Record<`scsi${number}` | `ide${number}` | `sata${number}` | `virtio${number}`, Disk>
  >;
  /** Create-only image import reference, not compared with an existing guest. */
  image?: string;
  /** Create-only initial public keys, not compared after creation. */
  sshKeys?: string[];
}
export type VirtualMachine = Resource<
  "Proxmox.VirtualMachine",
  VirtualMachineProps,
  GuestAttributes,
  never,
  import("./Providers.ts").Providers
>;
/**
 * Manage a QEMU VM, retaining it by default.
 *
 * ### Adopt an existing VM
 * **Example:** Explicit memory and disk capacity
 * ```typescript
 * const guest = yield* VirtualMachine("web", {
 *   node: "pve", vmid: 101,
 *   config: { memory: { current: 2048 }, scsi0: { discard: "on" } },
 *   disks: { scsi0: { storage: "local-lvm", sizeGiB: 32 } },
 * });
 * ```
 * @resource
 */
export const VirtualMachine = Resource<VirtualMachine>("Proxmox.VirtualMachine", {
  defaultRemovalPolicy: "retain",
});
export const VirtualMachineProvider = () =>
  Provider.succeed(VirtualMachine, {
    stables: ["node", "vmid"],
    read: Effect.fn(function* ({ fqn, olds, output }) {
      const owner = yield* createOwnershipTags(fqn);
      const identity = output ?? olds;
      const environment = yield* ProxmoxEnvironment.current;
      const found = yield* Effect.gen(function* () {
        const observed = yield* getNodesByNodeQemuByVmidConfig({
          node: identity.node,
          vmid: identity.vmid,
        });
        // Proxmox may include a cloud-init password in config. Never retain it.
        const { cipassword: _, ...config } = observed;
        const pending = yield* getNodesByNodeQemuByVmidPending({
          node: identity.node,
          vmid: identity.vmid,
        });
        return {
          node: identity.node,
          vmid: identity.vmid,
          config,
          pending: pending.filter(
            (item) => item.key !== "cipassword" && (item.pending !== undefined || item.delete),
          ),
        };
      }).pipe(
        Effect.catchTag("GuestNotFound", () => Effect.succeed(undefined)),
        Effect.mapError(
          (error) => new GuestReadFailed({ message: `Proxmox VM read failed (${error._tag})` }),
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
      const deltas = yield* planChanges("qemu", news, output, owner);
      for (const delta of deltas)
        yield* Effect.logInfo(
          `Proxmox ${fqn}: ${delta.path} (${delta.classification}) ${JSON.stringify(delta.live)} -> ${JSON.stringify(delta.declared)}`,
        );
      return { action: deltas.length ? "update" : "noop" } as const;
    }),
    reconcile: Effect.fn(function* ({ fqn, news }) {
      const environment = yield* ProxmoxEnvironment.current;
      const owner = yield* createOwnershipTags(fqn);
      return yield* reconcileGuest("qemu", news, owner).pipe(
        Effect.provide(nodeLayer(environment)),
      );
    }),
    delete: Effect.fn(function* ({ fqn, output }) {
      const environment = yield* ProxmoxEnvironment.current;
      const owner = yield* createOwnershipTags(fqn);
      yield* deleteGuest("qemu", output, owner).pipe(Effect.provide(nodeLayer(environment)));
    }),
  });
