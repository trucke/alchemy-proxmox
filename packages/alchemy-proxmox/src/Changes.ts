import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { normalizeConfig, record, type GuestKind } from "./Config.ts";
import { mergeTags, ownership } from "./Tags.ts";

/** A disk's existing volume identity is observed, not guessed from its VMID. */
export interface Disk {
  /** Proxmox storage ID. Moving an existing disk is not supported. */
  storage: string;
  /** Desired capacity in GiB. Growth is live; shrink is forbidden. */
  sizeGiB?: number;
}
export interface GuestDeclaration {
  node: string;
  vmid: number;
  config?: object;
  disks?: Record<string, Disk | undefined>;
}
export interface GuestAttributes {
  /** Node containing this guest. */
  node: string;
  /** Explicit guest identifier. */
  vmid: number;
  /** Observed API configuration, never credentials. */
  config: Record<string, unknown>;
  /** Pending changes reported by Proxmox. The provider never reboots. */
  pending: readonly { key: string; pending?: string; delete?: number; value?: string }[];
}
export type ChangeClass = "live" | "needs-reboot" | "not-supported" | "fixed";
export interface Change {
  path: string;
  declared: unknown;
  live: unknown;
  classification: ChangeClass;
}
export class UnsafeGuestChange extends Data.TaggedError("UnsafeGuestChange")<{
  message: string;
  changes: Change[];
}> {}
export class GuestPlanFailed extends Data.TaggedError("GuestPlanFailed")<{ message: string }> {}

/** Preserve policy failures in Effect's typed channel, not UnknownError.cause. */
export const planChanges = (
  kind: GuestKind,
  news: GuestDeclaration,
  output: GuestAttributes,
  owner: readonly string[],
) =>
  Effect.try({
    try: () => {
      const deltas = changes(kind, news, output, owner);
      validateChanges(deltas, output, owner);
      return deltas;
    },
    catch: (error) =>
      error instanceof UnsafeGuestChange
        ? error
        : new GuestPlanFailed({ message: "Invalid Proxmox guest declaration" }),
  });

export class GuestReadFailed extends Data.TaggedError("GuestReadFailed")<{ message: string }> {}

export function diskBytes(size: string): number {
  const match = /^(\d+(?:\.\d+)?)([KMGTPE]?)$/i.exec(size);
  if (!match) throw new Error("Invalid disk size");
  return Number(match[1]) * 1024 ** (match[2] ? "KMGTPE".indexOf(match[2].toUpperCase()) + 1 : 0);
}
function classify(kind: GuestKind, path: string, config: Record<string, unknown>): ChangeClass {
  const key = path.split(".")[0];
  if (["node", "vmid", "ostype", "unprivileged", "template", "arch"].includes(key)) return "fixed";
  if (/^dev\d+$/.test(key) || key === "cicustom") return "not-supported";
  if (/\.(ip|ip6|gw|gw6|bridge)$/.test(path) || /^ipconfig\d+$/.test(key)) return "not-supported";
  if (
    key === "name" &&
    Object.entries(config).some(
      ([k, v]) =>
        /^(ide|scsi|sata)\d+$/.test(k) && typeof v === "string" && v.includes("cloudinit"),
    )
  )
    return "not-supported";
  if (
    ["cores", "sockets", "cpu", "cpulimit", "cpuunits", "balloon"].includes(key) ||
    (kind === "qemu" && key === "memory")
  )
    return "needs-reboot";
  if (
    [
      "onboot",
      "startup",
      "tags",
      "description",
      "hostname",
      "name",
      "memory",
      "swap",
      "protection",
    ].includes(key) ||
    path.endsWith(".firewall")
  )
    return "live";
  // Unknown change surfaces fail closed until their lifecycle has been designed.
  return "not-supported";
}
function equal(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" && (b === 0 || b === 1)) return a === Boolean(b);
  return a === b;
}
/** Compare only declared leaves, retaining generated fields and user tags. */
export function changes(
  kind: GuestKind,
  news: GuestDeclaration,
  output: GuestAttributes,
  owner: readonly string[],
): Change[] {
  const result: Change[] = [];
  const add = (
    path: string,
    declared: unknown,
    live: unknown,
    classification = classify(kind, path, output.config),
  ) => {
    if (!equal(declared, live)) result.push({ path, declared, live, classification });
  };
  add("node", news.node, output.node);
  add("vmid", news.vmid, output.vmid);
  function compare(path: string, desired: unknown, observed: unknown) {
    if (desired === undefined) return;
    if (record(desired)) {
      for (const [key, value] of Object.entries(desired))
        compare(`${path}.${key}`, value, record(observed) ? observed[key] : undefined);
    } else if (
      /^(rootfs|mp\d+|scsi\d+|ide\d+|sata\d+|virtio\d+)\.size$/.test(path) &&
      typeof desired === "string" &&
      typeof observed === "string"
    ) {
      const wanted = diskBytes(desired);
      const current = diskBytes(observed);
      add(path, wanted, current, wanted < current ? "fixed" : "live");
    } else add(path, desired, observed);
  }
  for (const [key, value] of Object.entries(news.config ?? {})) {
    if (key === "tags") continue;
    compare(key, normalizeConfig(kind, key, value), normalizeConfig(kind, key, output.config[key]));
  }
  for (const [key, desired] of Object.entries(news.disks ?? {})) {
    if (!desired) continue;
    const disk = normalizeConfig(kind, key, output.config[key]);
    const volume = record(disk) ? (disk.volume ?? disk.file) : undefined;
    const storage = typeof volume === "string" ? volume.split(":")[0] : undefined;
    add(`${key}.storage`, desired.storage, storage, "not-supported");
    if (desired.sizeGiB !== undefined) {
      const size =
        record(disk) && typeof disk.size === "string"
          ? diskBytes(disk.size) / 1024 ** 3
          : undefined;
      add(
        `${key}.sizeGiB`,
        desired.sizeGiB,
        size,
        size !== undefined && desired.sizeGiB < size ? "fixed" : "live",
      );
    }
  }
  const tags = typeof output.config.tags === "string" ? output.config.tags : undefined;
  const declaredTags =
    record(news.config) && typeof news.config.tags === "string" ? news.config.tags : undefined;
  const wanted = mergeTags(tags, declaredTags, owner);
  if (wanted !== (tags ?? "")) add("tags", wanted, tags, "live");
  return result;
}
export function validateChanges(
  deltas: Change[],
  output: GuestAttributes,
  owner: readonly string[],
): void {
  const owned =
    ownership(typeof output.config.tags === "string" ? output.config.tags : undefined, owner) ===
    "owned";
  const observedTags = typeof output.config.tags === "string" ? output.config.tags : undefined;
  const tagOnly = mergeTags(observedTags, undefined, owner);
  const forbidden = deltas.filter(
    (delta) =>
      delta.classification === "fixed" ||
      delta.classification === "not-supported" ||
      (!owned && (delta.path !== "tags" || delta.declared !== tagOnly)),
  );
  if (forbidden.length)
    throw new UnsafeGuestChange({
      message: `${owned ? "Unsupported guest changes" : "Adoption must change only the ownership tags"}: ${forbidden.map((d) => `${d.path} (${d.classification}): declared ${JSON.stringify(d.declared)}, live ${JSON.stringify(d.live)}`).join("; ")}. No replacement will be planned.`,
      changes: forbidden,
    });
}
