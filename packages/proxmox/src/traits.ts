export * from "@distilled.cloud/core/trait";
export { RawResponse, RawResponseRoot } from "@distilled.cloud/core/protocol-rest";
import * as Schema from "effect/Schema";

/** The viewer omits family bounds; the server remains authoritative. */
export const FamilyKey = (prefix: string) => Schema.TemplateLiteral([prefix, Schema.Number]);
