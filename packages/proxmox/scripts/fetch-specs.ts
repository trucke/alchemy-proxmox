import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const version = "9.2.4";
// download.proxmox.com serves no valid HTTPS certificate. Trust comes from the signed release
// file, verified against Proxmox's trixie release key fetched over HTTPS and pinned here.
const repository = "http://download.proxmox.com/debian/pve/";
const releaseUrl = `${repository}dists/trixie/InRelease`;
const indexPath = "pve-no-subscription/binary-amd64/Packages";
const indexUrl = `${repository}dists/trixie/${indexPath}.gz`;
const keyUrl = "https://enterprise.proxmox.com/debian/proxmox-release-trixie.gpg";
/** "Proxmox Trixie Release Key", as listed on Proxmox's ISO download pages. */
const keyFingerprint = "24B30F06ECC1836A4E5EFECBA7BCD1420BFE778E";
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
async function download(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Verifies InRelease with gpgv against the pinned key and parses only the signed text. */
async function verifyRelease(directory: string) {
  // A fresh home directory keeps the user's own keyrings out of the check.
  const home = join(directory, "gnupg");
  await mkdir(home, { mode: 0o700 });
  const keyring = join(home, "proxmox-release-trixie.gpg");
  await writeFile(keyring, await download(keyUrl));
  const signed = await download(releaseUrl);
  await writeFile(join(home, "InRelease"), signed);
  const result = spawnSync(
    "gpgv",
    ["--homedir", home, "--keyring", keyring, "--status-fd", "2", "--output", "-", "InRelease"],
    { cwd: home, encoding: "utf8" },
  );
  if (result.error) throw new Error("gpgv is required to verify the repository signature");
  // gpgv exits 0 only for good signatures. VALIDSIG ends with the primary key fingerprint.
  const signers = [...result.stderr.matchAll(/^\[GNUPG:\] VALIDSIG .* ([0-9A-F]{40})$/gm)].map(
    (match) => match[1],
  );
  if (result.status !== 0 || signers.length === 0 || signers.some((fpr) => fpr !== keyFingerprint))
    throw new Error("InRelease is not signed by the pinned Proxmox release key");
  const text = result.stdout;
  const field = (name: string) => text.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
  const date = field("Date");
  if (field("Codename") !== "trixie" || !date) throw new Error("Unexpected InRelease fields");
  const listed = new Map(
    (text.match(/^SHA256:\n((?: .+\n)+)/m)?.[1] ?? "")
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, size, path] = line.trim().split(/\s+/);
        return [path, { hash, size: Number(size) }] as const;
      }),
  );
  return {
    sha256: sha256(signed),
    date,
    check(path: string, data: Uint8Array) {
      const expected = listed.get(path);
      if (!expected || sha256(data) !== expected.hash || data.length !== expected.size)
        throw new Error(`${path} does not match the SHA256 entry in InRelease`);
    },
  };
}

const temp = await mkdtemp(join(tmpdir(), "proxmox-spec-"));
try {
  const release = await verifyRelease(temp);
  const compressed = await download(indexUrl);
  release.check(`${indexPath}.gz`, compressed);
  const index = gunzipSync(compressed);
  release.check(indexPath, index);
  const entry = index
    .toString()
    .split(/\n\n/)
    .find(
      (entry) => entry.includes("Package: pve-docs\n") && entry.includes(`Version: ${version}\n`),
    );
  if (!entry) throw new Error(`pve-docs ${version} missing from ${indexUrl}`);
  const field = (name: string) => {
    const value = entry.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
    if (!value) throw new Error(`Missing ${name} in package index`);
    return value;
  };
  const url = new URL(field("Filename"), repository).href;
  const deb = await download(url);
  if (sha256(deb) !== field("SHA256")) throw new Error("Package checksum mismatch");
  await writeFile(join(temp, "package.deb"), deb);
  execFileSync("ar", ["x", "package.deb"], { cwd: temp });
  const archive = (await readdir(temp)).find((file) => file.startsWith("data.tar"));
  if (!archive) throw new Error("Debian package has no data archive");
  execFileSync("tar", ["xf", archive, "./usr/share/pve-docs/api-viewer/apidoc.js"], { cwd: temp });
  const source = await readFile(join(temp, "usr/share/pve-docs/api-viewer/apidoc.js"), "utf8");
  const match = source.match(/^const apiSchema = (\[[\s\S]*?^\])/m);
  if (!match) throw new Error("Missing apiSchema JSON array");
  const schema: unknown = JSON.parse(match[1]);
  if (!Array.isArray(schema) || schema.length === 0) throw new Error("Empty schema");
  function countOperations(nodes: unknown[]): number {
    return nodes.reduce<number>((count, node) => {
      if (
        node === null ||
        typeof node !== "object" ||
        !("path" in node) ||
        typeof node.path !== "string"
      )
        throw new Error("Invalid schema tree node");
      const info = "info" in node ? node.info : {};
      const children = "children" in node ? node.children : [];
      if (info === null || typeof info !== "object" || !Array.isArray(children))
        throw new Error("Invalid schema tree structure");
      return count + Object.keys(info).length + countOperations(children);
    }, 0);
  }
  if (countOperations(schema) !== 678) throw new Error("Expected 678 API operations");
  const payload = JSON.stringify(schema, null, 2) + "\n";
  const output = new URL("../specs/spec-mirror-proxmox/specs/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL("api-schema.json", output), payload);
  await writeFile(
    new URL("provenance.json", output),
    JSON.stringify(
      {
        package: "pve-docs",
        version,
        repository,
        release: {
          url: releaseUrl,
          sha256: release.sha256,
          date: release.date,
          verifiedWith: "gpgv",
          keyUrl,
          keyFingerprint,
        },
        indexUrl,
        indexSha256: sha256(index),
        packageUrl: url,
        packageSha256: sha256(deb),
        apidocSha256: sha256(source),
        schemaSha256: sha256(payload),
        // Identity and checksums only; Debian's free-text package description is not kept.
        packageIndexEntry: entry.replace(/\nDescription:[\s\S]*$/, ""),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Extracted pve-docs ${version}; apidoc SHA256 ${sha256(source)}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
