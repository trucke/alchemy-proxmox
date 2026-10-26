import { FORMAT, type Model } from "./convert.ts";
import { namedPropertyFormats } from "./property-formats.ts";

/** Emit every inline property-string schema, retaining operation-specific differences. */
export function generatePropertyStrings(models: Record<string, Model>): string {
  const lines = [
    "// Generated from pve-docs. Do not edit.",
    'import { propertyString } from "./property-string.ts";',
  ];
  for (const [area, model] of Object.entries(models)) {
    lines.push(`export const ${area} = {`);
    for (const [name, shape] of Object.entries(model.shapes)) {
      const formats = Object.entries(shape.members ?? {}).flatMap(([key, member]) => {
        const trait = member.traits?.[FORMAT];
        const format = typeof trait === "string" ? namedPropertyFormats[trait] : trait;
        if (!format || typeof format !== "object" || Array.isArray(format)) return [];
        // Descriptions and Perl regexes are not needed by the wire codec. Keep
        // only its structural schema; server-side validation remains authoritative.
        const fields = Object.fromEntries(
          Object.entries(format).map(([name, field]) => [
            name,
            Object.fromEntries(
              Object.entries(field).filter(([key]) =>
                ["type", "optional", "default_key", "alias", "keyAlias", "enum"].includes(key),
              ),
            ),
          ]),
        );
        return [`${JSON.stringify(key)}: propertyString(${JSON.stringify(fields)}),`];
      });
      if (formats.length) lines.push(`${JSON.stringify(name.split("#")[1])}: {`, ...formats, "},");
    }
    lines.push("};");
  }
  return lines.join("\n") + "\n";
}
