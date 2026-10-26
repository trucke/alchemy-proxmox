import { nodes_lxc, nodes_qemu } from "@distilled.cloud/proxmox/property-strings";
import type { PropertyFormat } from "@distilled.cloud/proxmox/property-string";

export const containerCodecs = nodes_lxc.PutNodesByNodeLxcByVmidConfigRequest;
export const virtualMachineCodecs = nodes_qemu.PutNodesByNodeQemuByVmidConfigRequest;
type Codec = { decode: (input: string) => object; format: PropertyFormat };
type Expanded<C> = {
  [K in keyof C as K extends `${infer Prefix}[n]` ? `${Prefix}${number}` : K]: C[K];
};
/** Structured fields compare only declared keys. Raw strings are decoded identically. */
export type StructuredConfig<Wire, C> = Omit<Wire, keyof Expanded<C>> & {
  [K in keyof Expanded<C>]?:
    | string
    | (Expanded<C>[K] extends Codec ? Partial<ReturnType<Expanded<C>[K]["decode"]>> : never);
};
export type GuestKind = "lxc" | "qemu";
export const codecsFor = (kind: GuestKind): Record<string, Codec> =>
  kind === "lxc" ? containerCodecs : virtualMachineCodecs;

/** Named formats have no inline schema in pve-docs. Keep their values as strings. */
function namedProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, part] of text.split(",").entries()) {
    const equals = part.indexOf("=");
    const key = equals < 0 ? "$" : part.slice(0, equals);
    if (equals < 0 && index !== 0) throw new Error("Unnamed property must be first");
    if (Object.hasOwn(result, key)) throw new Error("Duplicate property key");
    result[key] = equals < 0 ? part : part.slice(equals + 1);
  }
  return result;
}
export function normalizeConfig(kind: GuestKind, key: string, value: unknown): unknown {
  if (value === undefined) return value;
  // Proxmox stores descriptions as config comments and appends a final newline on reads.
  if (key === "description" && typeof value === "string") return value.replace(/\n+$/, "");
  const codec = codecsFor(kind)[key] ?? codecsFor(kind)[key.replace(/\d+$/, "[n]")];
  if (codec && typeof value === "string") return codec.decode(value);
  if (typeof value === "string" && ["startup", "cpu", "boot", "cicustom"].includes(key))
    return namedProperties(value);
  return value;
}
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
