import { createInternalTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

/**
 * Marks a guest as managed by Alchemy. The stack and stage tags only count next to this marker,
 * so ordinary user tags with the same names never imply ownership.
 */
export const OWNERSHIP_MARKER = "alchemy";
/** Proxmox's `pve-tag` format. Tags compare case-insensitively here. */
const PROXMOX_TAG = /^[a-z0-9_][a-z0-9_.+-]*$/i;

export class InvalidOwnershipName extends Data.TaggedError("InvalidOwnershipName")<{
  message: string;
}> {}

/** The tags that mark a guest as owned by this stack and stage: the marker, the stack, the stage. */
export function ownershipTags(stack: string, stage: string): readonly string[] {
  for (const [kind, name] of [
    ["Stack", stack],
    ["Stage", stage],
  ] as const) {
    if (!PROXMOX_TAG.test(name))
      throw new InvalidOwnershipName({
        message: `${kind} name "${name}" cannot be a Proxmox tag; use letters, digits, "_", ".", "+" and "-", starting with a letter, digit or "_"`,
      });
  }
  return [...new Set([OWNERSHIP_MARKER, stack.toLowerCase(), stage.toLowerCase()])];
}
export const createOwnershipTags = Effect.fn(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return yield* Effect.try({
    try: () => ownershipTags(tags["alchemy::stack"], tags["alchemy::stage"]),
    catch: (error) =>
      error instanceof InvalidOwnershipName
        ? error
        : new InvalidOwnershipName({ message: "Invalid Proxmox ownership name" }),
  });
});
export const parseTags = (tags: string | undefined) => (tags ?? "").split(";").filter(Boolean);

export type Ownership = "owned" | "foreign" | "unmanaged";
/**
 * Without the marker a guest is unmanaged. With the marker it is owned when it also carries this
 * stack's and stage's tags, and foreign otherwise.
 */
export function ownership(tags: string | undefined, owner: readonly string[]): Ownership {
  const present = new Set(parseTags(tags).map((tag) => tag.toLowerCase()));
  if (!present.has(OWNERSHIP_MARKER)) return "unmanaged";
  return owner.every((tag) => present.has(tag)) ? "owned" : "foreign";
}
/** Proxmox tags are a set, not a key/value map. Keep every existing tag and add the missing owner tags. */
export function mergeTags(
  existing: string | undefined,
  declared: string | undefined,
  owner: readonly string[],
): string {
  const merged = new Map<string, string>();
  for (const tag of [...parseTags(existing), ...parseTags(declared), ...owner]) {
    if (!PROXMOX_TAG.test(tag)) throw new Error("Invalid Proxmox tag");
    if (!merged.has(tag.toLowerCase())) merged.set(tag.toLowerCase(), tag);
  }
  return [...merged.values()].join(";");
}
