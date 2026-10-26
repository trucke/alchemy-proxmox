import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSchema } from "./convert.ts";

// The schema carries documentation text from Proxmox's sources. The repository keeps only
// structural interface information, so no schema string with at least four words may appear
// in a file that is or would be committed. Matching compares lowercase runs of letters, digits
// and underscores, so line breaks, comment markers, escapes and punctuation do not hide a copy.
// Underscores keep identifiers such as `create_widget_entry` from matching prose. Escaped
// line breaks and tabs count as spaces, so `\nNext` in a JSON string still yields `next`.
const minWords = 4;
const words = (text: string) =>
  text
    .replace(/\\[nrt]/g, " ")
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
const isProse = (text: string) =>
  text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length >= minWords;

/** Every string value in the schema, whatever its key. Property names are identifiers. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) yield* strings(item);
}

const prose = new Set([...strings(await readSchema())].filter(isProse));
// Index the word sequences by their first words to scan each file once.
const index = new Map<string, { text: string; words: string[] }[]>();
for (const text of prose) {
  const sequence = words(text);
  const key = sequence.slice(0, minWords).join(" ");
  index.set(key, [...(index.get(key) ?? []), { text, words: sequence }]);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync(
  "git",
  ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
let scanned = 0;
const matches: string[] = [];
for (const file of new Set(files)) {
  let content: string;
  try {
    content = await readFile(join(root, file), "utf8");
  } catch (error) {
    // Files deleted in the working copy can still be listed by the Git index.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
  scanned++;
  const haystack = words(content);
  for (let i = 0; i + minWords <= haystack.length; i++) {
    for (const candidate of index.get(haystack.slice(i, i + minWords).join(" ")) ?? []) {
      if (candidate.words.every((word, j) => haystack[i + j] === word))
        matches.push(`${file}: ${JSON.stringify(candidate.text.slice(0, 100))}`);
    }
  }
}

console.log(
  `Prose check: ${prose.size} schema strings with at least ${minWords} words, ${scanned} files, ${matches.length} matches`,
);
if (matches.length) {
  console.error(matches.join("\n"));
  process.exitCode = 1;
}
