import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { generateService, type SdkSpec } from "@distilled.cloud/core/codegen/generator";
import type { Model } from "./convert.ts";
import { generatePropertyStrings } from "./property-strings.ts";
import { JSON_PRELUDE, TS_JSON_PRELUDE } from "@distilled.cloud/core/codegen/prelude";

// Core has no indexed-family trait. Keep the Smithy metadata intact and lower
// those members to template-key records at the final emission boundary.
export function lowerFamilies(code: string): string {
  return code
    .replace(/as any as /g, "as unknown as ")
    .replace(/"(\w+)\[n\]"\?: string;/g, "[key: `$1${number}`]: string | undefined;")
    .replace(/S\.Struct\(\{(\n[\s\S]*?)^\}\)/gm, (whole: string, fields: string) => {
      const families: string[] = [];
      const rest = fields.replace(
        /^  "(\w+)\[n\]": S\.optional\(S\.String\),\n/gm,
        (_, prefix: string) => {
          families.push(`S.Record(T.FamilyKey(${JSON.stringify(prefix)}), S.String)`);
          return "";
        },
      );
      return families.length
        ? `S.StructWithRest(S.Struct({${rest}}), [${families.join(", ")}])`
        : whole;
    });
}

const spec: SdkSpec = {
  sourceNote: ".generated-specs (pve-docs 9.2.4)",
  prelude: { ...JSON_PRELUDE, Boolean: "S.Union([S.Boolean, S.Literals([0, 1])])", Unit: "S.Null" },
  tsPrelude: { ...TS_JSON_PRELUDE, Boolean: "boolean | 0 | 1", Unit: "null" },
  postProcess: lowerFamilies,
  extraBindings: [
    {
      trait: "com.distilled.openapi#rawResponse",
      binding: "rawResponse",
      pipe: "T.RawResponse()",
      rootPipe: "T.RawResponseRoot()",
    },
  ],
  operationDecl: {
    contextType: "ProxmoxOpContext",
    commonErrorType: "ProxmoxOpError",
    commonErrorClasses: ["UnknownProxmoxError"],
    protocol: "ProxmoxProtocol",
  },
};
const root = new URL("../", import.meta.url);
const output = new URL("src/services/", root);
await mkdir(output, { recursive: true });
const files = (await readdir(new URL(".generated-specs/", root)))
  .filter((f) => f.endsWith(".json"))
  .sort();
const models: Record<string, Model> = {};
for (const file of files) {
  const model: Model = JSON.parse(
    await readFile(new URL(`.generated-specs/${file}`, root), "utf8"),
  );
  models[file.slice(0, -5)] = model;
  const result = generateService(model, spec);
  await writeFile(new URL(file.replace(/\.json$/, ".ts"), output), result.code);
}
await writeFile(
  new URL("index.ts", output),
  files
    .map(
      (file) =>
        `export * as ${file.slice(0, -5).replace(/[_-]([a-z])/g, (_, c: string) => c.toUpperCase())} from "./${file.replace(/\.json$/, ".ts")}";`,
    )
    .join("\n") + "\n",
);
const expected = new Set(["index.ts", ...files.map((file) => file.replace(/\.json$/, ".ts"))]);
for (const file of await readdir(output)) {
  if (file.endsWith(".ts") && !expected.has(file)) await rm(new URL(file, output));
}
await writeFile(new URL("src/property-strings.ts", root), generatePropertyStrings(models));
console.log(`Generated ${files.length} service modules`);
