import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface JsonSchema {
  type?: string;
  optional?: number | boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: (string | number)[];
  format?: unknown;
  [key: string]: unknown;
}
export interface ApiNode {
  path: string;
  children?: ApiNode[];
  info?: Record<
    string,
    {
      name: string;
      parameters?: JsonSchema;
      returns?: JsonSchema;
      allowtoken?: number;
      protected?: number;
      [key: string]: unknown;
    }
  >;
}
type Member = { target: string; traits?: Record<string, unknown> };
type Shape = {
  type: string;
  traits?: Record<string, unknown>;
  members?: Record<string, Member>;
  member?: Member;
  key?: Member;
  value?: Member;
  input?: Member;
  output?: Member;
  version?: string;
  operations?: Member[];
};
export interface Model {
  smithy: string;
  metadata: Record<string, unknown>;
  shapes: Record<string, Shape>;
}
export const FORMAT = "proxmox.api#format";
export const FAMILY = "proxmox.api#family";

// The schema mixes interface structure with documentation text from Proxmox's
// sources. Models keep only these keywords, so descriptions, type texts, titles
// and permission texts never reach generated files.
const KEYWORDS = new Set([
  "type",
  "properties",
  "items",
  "optional",
  "enum",
  "default",
  "default_key",
  "alias",
  "keyAlias",
  "format",
  "pattern",
  "requires",
  "minimum",
  "maximum",
  "min",
  "max",
  "minLength",
  "maxLength",
  "additionalProperties",
]);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const structuralMap = (schemas: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(schemas).map(([key, value]) => [
      key,
      isObject(value) ? structural(value) : value,
    ]),
  );
/** Copies a schema with structural keywords only, recursing into nested schemas. */
function structural(schema: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) continue;
    // Some defaults describe computed behavior in words instead of giving a value.
    if (key === "default" && typeof value === "string" && /\s/.test(value)) continue;
    if (!isObject(value)) copy[key] = value;
    else if (key === "properties" || key === "format") copy[key] = structuralMap(value);
    else if (key === "items" || key === "additionalProperties") copy[key] = structural(value);
    else copy[key] = value;
  }
  return copy;
}
const pascal = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
export function convert(tree: ApiNode[]) {
  const models: Record<string, Model> = {};
  let count = 0;
  function visit(node: ApiNode) {
    const parts = node.path.split("/").filter((p) => p && !p.startsWith("{"));
    const area =
      parts[0] === "nodes" && parts[1] ? `nodes_${parts[1].replaceAll("-", "_")}` : parts[0];
    for (const [method, operation] of Object.entries(node.info ?? {})) {
      const model = (models[area] ??= {
        smithy: "2.0",
        metadata: { source: "pve-docs 9.2.4" },
        shapes: {},
      });
      const ns = `proxmox.${area}#`;
      // Include path labels to disambiguate collection and item operations with identical upstream names.
      const name = pascal(method.toLowerCase() + " " + node.path.replace(/\{([^}]+)\}/g, "by $1"));
      const id = ns + name;
      if (model.shapes[id]) throw new Error(`Duplicate operation ${id}`);
      function shape(schema: JsonSchema, local: string): string {
        const target = ns + local;
        if (schema.type === "object" || schema.properties) {
          if (!schema.properties || Object.keys(schema.properties).length === 0) {
            model.shapes[target] = {
              type: "map",
              key: { target: "smithy.api#String" },
              value: { target: "smithy.api#Document" },
            };
          } else {
            model.shapes[target] = { type: "structure", members: members(schema, local) };
          }
        } else if (schema.type === "array") {
          model.shapes[target] = {
            type: "list",
            member: { target: shape(schema.items ?? {}, local + "Item") },
          };
        } else if (schema.enum && schema.type === "string") {
          model.shapes[target] = {
            type: "enum",
            members: Object.fromEntries(
              schema.enum.map((value, i) => [
                `Value${i}`,
                { target: "smithy.api#Unit", traits: { "smithy.api#enumValue": value } },
              ]),
            ),
          };
        } else {
          return (
            {
              string: "smithy.api#String",
              integer: "smithy.api#Integer",
              number: "smithy.api#Double",
              boolean: "smithy.api#Boolean",
              null: "smithy.api#Unit",
            }[schema.type ?? ""] ?? "smithy.api#Document"
          );
        }
        return target;
      }
      function members(schema: JsonSchema, local: string, input = false): Record<string, Member> {
        return Object.fromEntries(
          Object.entries(schema.properties ?? {}).map(([key, value]) => {
            const traits: Record<string, unknown> = {};
            if (!value.optional && !key.includes("[n]")) traits["smithy.api#required"] = {};
            if (value.format !== undefined)
              traits[FORMAT] = isObject(value.format) ? structuralMap(value.format) : value.format;
            if (key.includes("[n]")) traits[FAMILY] = { pattern: key, schema: structural(value) };
            if (input) {
              if (node.path.includes(`{${key}}`)) traits["smithy.api#httpLabel"] = {};
              else if (method === "GET" || method === "DELETE")
                traits["smithy.api#httpQuery"] = key;
            }
            return [key, { target: shape(value, local + pascal(key)), traits }];
          }),
        );
      }
      model.shapes[id + "Request"] = {
        type: "structure",
        members: members(operation.parameters ?? {}, name + "Request", true),
      };
      const returns = operation.returns ?? {};
      const output = shape(returns, name + "Result");
      model.shapes[id + "Response"] = {
        type: "structure",
        members: {
          data: {
            target: output,
            traits: { "smithy.api#required": {}, "com.distilled.openapi#rawResponse": {} },
          },
        },
      };
      model.shapes[id] = {
        type: "operation",
        input: { target: id + "Request" },
        output: { target: id + "Response" },
        traits: {
          "smithy.api#http": { method, uri: node.path, code: 200 },
          // Our own structural summary instead of Proxmox's description.
          "smithy.api#documentation": `${method} ${node.path}`,
          "proxmox.api#access": {
            allowtoken: operation.allowtoken,
            protected: operation.protected,
          },
          "proxmox.api#upstreamName": operation.name,
        },
      };
      const service = (model.shapes[ns + "Service"] ??= {
        type: "service",
        version: "9.2.4",
        operations: [],
      });
      service.operations!.push({ target: id });
      count++;
    }
    node.children?.forEach(visit);
  }
  tree.forEach(visit);
  return { models, count };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Reads the schema written by `pnpm specs:fetch`. The schema is not committed, so this stops
 * with instructions when it is missing or does not match the committed provenance.
 */
export async function readSchema(): Promise<ApiNode[]> {
  const specs = new URL("../specs/spec-mirror-proxmox/specs/", import.meta.url);
  const fetch = "Run `pnpm specs:fetch` to download and verify it.";
  let text: string;
  try {
    text = await readFile(new URL("api-schema.json", specs), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      fail(`The Proxmox API schema is not committed and has not been fetched yet. ${fetch}`);
    throw error;
  }
  const provenance: { schemaSha256: string } = JSON.parse(
    await readFile(new URL("provenance.json", specs), "utf8"),
  );
  if (createHash("sha256").update(text).digest("hex") !== provenance.schemaSha256)
    fail(`api-schema.json does not match schemaSha256 in provenance.json. ${fetch}`);
  return JSON.parse(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL("../", import.meta.url);
  const { models, count } = convert(await readSchema());
  if (count !== 678) throw new Error(`Expected 678 operations, got ${count}`);
  const output = new URL(".generated-specs/", root);
  await mkdir(output, { recursive: true });
  for (const file of await readdir(output))
    if (file.endsWith(".json")) await rm(new URL(file, output));
  for (const [area, model] of Object.entries(models))
    await writeFile(new URL(`${area}.json`, output), JSON.stringify(model, null, 2) + "\n");
  console.log(`Converted ${count} operations in ${Object.keys(models).length} services`);
}
