# @distilled.cloud/proxmox

Effect v4 client generated from Proxmox VE's `pve-docs` 9.2.4 API schema.
The client contains 678 operations across 49 API-area modules. It is not published to npm yet.
Inline property-string schemas generate typed codecs. The Alchemy provider lives in
[`../alchemy-proxmox`](../alchemy-proxmox/README.md).

## Develop and regenerate

Requires Node 24 and pnpm 12.15.0. `pnpm specs:fetch` also requires `gpgv` (GnuPG), `ar` and
a `tar` that supports the Debian package's compression. Run these commands from the repository
root:

1. Install the pinned dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

2. Fetch the pinned schema. It is not committed, and `convert` and `generate` need it:

   ```sh
   pnpm specs:fetch
   ```

   `download.proxmox.com` has no valid HTTPS certificate, so the script authenticates the
   repository through its signed release file instead:

   1. It fetches Proxmox's trixie release key over HTTPS from `enterprise.proxmox.com`.
   2. It verifies `dists/trixie/InRelease` with `gpgv` and accepts it only when the signing
      key's fingerprint matches the one pinned in `scripts/fetch-specs.ts`
      (`24B30F06ECC1836A4E5EFECBA7BCD1420BFE778E`, as listed on Proxmox's ISO download
      pages). It reads only the signed text.
   3. It checks the `trixie/pve-no-subscription` package index, compressed and uncompressed,
      against the SHA256 and size listed in `InRelease`.
   4. It finds `pve-docs` 9.2.4 in that index and checks the `.deb` against the entry's SHA256.

   The script then extracts the JSON array from `apidoc.js` without executing JavaScript and
   checks for 678 operations. It writes `api-schema.json` and `provenance.json` to
   `specs/spec-mirror-proxmox/specs/`. Git ignores `api-schema.json`; only `provenance.json`
   is committed. It records the URLs, the verified `InRelease` (SHA256, date, key URL and
   fingerprint), the package index entry and SHA256 checksums of the index, package,
   `apidoc.js` and JSON payload. Re-running the script reproduces `api-schema.json` byte for
   byte. The `release` fields and the index checksum change whenever Proxmox publishes a new
   package index.

3. Convert and generate:

   ```sh
   pnpm convert
   pnpm generate
   ```

   `convert` writes Smithy models to `.generated-specs/`. It stops with an instruction to run
   `pnpm specs:fetch` when the schema is missing or its SHA256 differs from `schemaSha256` in
   `provenance.json`. `generate` repeats conversion, compiles those models with the pinned
   `@distilled.cloud/core` codegen and formats the TypeScript output in `src/services/`. It
   ends with `pnpm check:prose` (see [Doc comments](#doc-comments)). Never edit generated
   files. Regenerating from the same schema leaves every generated file unchanged.

   The models and services are committed, so installation and the checks below need neither
   the schema nor network access to Proxmox.

4. Check the result:

   ```sh
   pnpm typecheck
   pnpm lint
   pnpm format:check
   pnpm test
   ```

   Typechecking includes every generated service. Tests use a mocked HTTP client and
   constructed responses, not a live node.

### Doc comments

Generated operations carry structural doc comments that name the HTTP method and path, for
example `/** POST /nodes/{node}/lxc */`. Request and response members have none. Proxmox's
descriptions are written in its own sources and published as its documentation, and this
repository does not redistribute them. Look up a call in Proxmox's
[API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) by its path.

`scripts/convert.ts` copies only structural schema keywords into the models: types, formats,
enums, defaults, constraints and flags. `pnpm check:prose` collects every schema string with at
least four words and fails if one appears in a file that Git tracks or would track. It prints
the number of strings and files scanned and the number of matches. Run it after editing docs:

```sh
pnpm check:prose
```

It needs the fetched schema. See [the design](../../docs/DESIGN.md#proxmox-schema-text) for the
reasoning.

## Run a read-only smoke check

Use a token with permission to list guests and read their configurations. The script makes
only GET requests. It does not start tasks or modify guests.

1. Inject `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET` through your secret manager.
   Do not put their values in command-line arguments or source files.
2. Set the endpoint and optional CA:

   ```sh
   export PROXMOX_ENDPOINT='https://pve.example.com:8006/api2/json'
   export PROXMOX_CA_CERT="$(< /path/to/ca.pem)"
   ```

   `PROXMOX_CA_CERT` contains PEM text, not a filename. Omit it for a publicly trusted
   certificate. Use the DNS name covered by the certificate, not the node's IP address.

3. Run the script:

   ```sh
   pnpm smoke
   ```

The script lists guests with `/cluster/resources?type=vm` and reads each LXC or QEMU config.
It prints VMID, type, name, node, status, cores, memory and the number of config keys.
Memory is reported in the config API's units (MiB). It never prints whole configs.
Successful completion prints the number of configs read.

On failure, the script prints only the error tag, the transport reason and the HTTP status
when known, for example `Smoke failed: Forbidden (HTTP 403)` or
`Smoke failed: HttpClientError (TransportError)`. It never prints requests, headers, response
bodies, messages or credentials. `describeError` in `src/errors.ts` produces this summary.

### Live validation

On 2026-10-25 the smoke check ran against a Proxmox VE 9.2.11 node with a pool-scoped API token. It
listed every guest (containers and VMs) and read every config, using GET requests only.

Recorded responses from the same node:

| Request                                                | Response                                                                                                                                                                          | Client result              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Invalid enum value (`/cluster/resources?type=invalid`) | HTTP 400, body `{"errors":{"type":"value 'invalid' does not have a value in the enumeration 'vm, storage, node, sdn'"},"data":null,"message":"Parameter verification failed.\n"}` | `ParameterValidationError` |
| Config of a missing container                          | HTTP 500, body `{"data":null,"message":"Configuration file 'nodes/<node>/lxc/<vmid>.conf' does not exist\n"}`                                                                     | Generic server error       |
| Config of a missing VM                                 | HTTP 500, same shape with `qemu-server/<vmid>.conf`                                                                                                                               | Generic server error       |
| Unknown node name                                      | HTTP 500, message `hostname lookup '<node>' failed - ...`                                                                                                                         | Generic server error       |

Proxmox reports a missing guest as HTTP 500, not 404. The client now maps HTTP 500 with
`data: null` and the guest-configuration message shape above to `GuestNotFound`.
Other 500 responses retain core's server error. Matching happens in the protocol alongside
parameter-validation mapping and is included in every generated operation's typed error union.
The table records the milestone 1 result before that mapping was added.

The messages in this table and the error messages in the tests, such as
`Parameter verification failed.`, `Configuration file '...' does not exist` and the 403
`Permission check failed (...)` text, are recorded API responses. They stay verbatim because
the client and the tests match them.

Value types differ between guest kinds: a VM's `memory` arrives as a string (`"8192"`, it is a
property string), a container's as a number. Array encoding with repeated keys is still
unconfirmed: the networkless live VM did not have an available guest agent, so the array-valued
exec request could not be exercised. The completed lifecycle verified scalar forms, boolean
`0`/`1`, property strings, semicolon-separated tags and comma-separated `delete` values.
A `delete` list is a schema string, not an array.

## Use the client

Run this from the workspace with the environment above. The generated names include HTTP
method and path segments to avoid collisions between Proxmox's repeated operation names.

```ts
import * as Effect from "effect/Effect";
import * as Proxmox from "@distilled.cloud/proxmox";
import { nodeLayer } from "@distilled.cloud/proxmox/node";

const program = Effect.gen(function* () {
  const guests = yield* Proxmox.cluster.getClusterResources({ type: "vm" });
  for (const guest of guests) {
    if (!guest.node || !guest.vmid) continue;
    const input = { node: guest.node, vmid: guest.vmid };
    if (guest.type === "lxc") {
      const config = yield* Proxmox.nodesLxc.getNodesByNodeLxcByVmidConfig(input);
      console.log({ type: guest.type, configKeys: Object.keys(config).length });
    } else if (guest.type === "qemu") {
      const config = yield* Proxmox.nodesQemu.getNodesByNodeQemuByVmidConfig(input);
      console.log({ type: guest.type, configKeys: Object.keys(config).length });
    }
  }
});

const config = await Effect.runPromise(Proxmox.configFromEnv);
await Effect.runPromise(program.pipe(Effect.provide(nodeLayer(config))));
```

`credentials(config)` accepts an endpoint, redacted token ID, redacted token secret and optional
CA PEM. `CredentialsFromEnv` provides the same service using Effect's redacted config reader.
`nodeLayer(config)` additionally provides a scoped Node HTTP client with certificate and hostname
verification enabled. A custom HTTP client must configure CA trust itself. Protocol selection is
attached to generated operations, so callers do not need to provide `ProxmoxProtocol` separately.

## Property-string codecs

`pnpm generate` also emits `src/property-strings.ts` from the inline `format` traits.
Codecs are grouped by service, operation shape and field. Indexed families share one codec
for every index:

```ts
import { nodes_lxc, nodes_qemu } from "@distilled.cloud/proxmox/property-strings";

const network = nodes_lxc.PutNodesByNodeLxcByVmidConfigRequest["net[n]"];
const wire = network.encode({ name: "eth0", ip: "dhcp", firewall: true });
const parsed = network.decode(wire);
const memory = nodes_qemu.PutNodesByNodeQemuByVmidConfigRequest.memory.decode("2048");
// memory.current === 2048
```

One runtime codec handles required and optional keys, numeric values, booleans, unnamed
`default_key` values and aliases, including network model aliases such as `virtio=<MAC>`.
Encoding uses canonical names. Duplicate keys, malformed scalars and ambiguous delimiters
fail without including values in errors. Omitted defaults are not materialized. Constraints
such as Perl regexes, numeric ranges and supported family indexes remain server-validated.

The viewer exposes several formats only by name, not as a sub-schema. These cannot yet
produce typed codecs without supplemental metadata. `scripts/property-formats.ts` supplies a
hand-written structure for `pve-qm-ipconfig` (keys `ip`, `gw`, `ip6` and `gw6`, all optional
strings). It uses the same generated codec as inline formats. The reference is
[pinned qemu-server source](https://git.proxmox.com/?p=qemu-server.git;a=blob;f=src/PVE/QemuServer/Network.pm;hb=71ea0ac7192bb935f63cb64beb59e87d6cecd3bf).
Named formats such as `pve-qm-cicustom`,
`pve-vm-cpu-conf` and `pve-startup-order` remain strings. The provider compares their declared
properties with a shared tokenizer. IP syntax and gateway dependencies remain server-validated.

## Wire behavior and limits

- Authentication is `Authorization: PVEAPIToken=<token-id>=<secret>`.
- Bodies are form encoded. Boolean inputs become `0` or `1`, including query parameters.
  Arrays use repeated keys; this convention has only been checked offline.
- Successful responses unwrap `{ "data": ... }`. Response flags retain their wire representation:
  `boolean | 0 | 1`. Property strings remain raw strings.
- Indexed parameters have template-key types such as `net${number}`, not a literal `net[n]` field.
  Their property-string schemas and named formats remain in Smithy traits.
  The viewer omits machine-readable family bounds, so the server enforces supported indexes.
- HTTP failures use core's tagged status errors. HTTP 400 with an `errors` object becomes
  `ParameterValidationError`, preserving per-parameter messages. Unknown statuses become
  `UnknownProxmoxError`. Do not log error bodies indiscriminately: API responses can contain secrets.
  `describeError(error)` returns a log-safe summary with tag and HTTP status only.
- Core's optional `ResponseValidation.strict` and `ResponseValidation.additionalProperties`
  layers produce `ProxmoxParseError`. Default validation is lenient, matching distilled.
  Schema enums use core's forward-compatible string schemas at runtime.
- `waitForTask(node, upid, { timeout })` polls with 500ms exponential backoff capped at 5s until
  a wall-clock deadline, 2 minutes unless `timeout` says otherwise. `OK` succeeds with
  `warnings: 0`; `WARNINGS: <n>` succeeds with that count. Other terminal results fail with
  `TaskFailed`; the deadline fails with `TaskTimeout`. Transport errors propagate rather than
  being silently retried.
- The schema includes writes, root-only operations, uploads and console endpoints. Generation
  does not imply token permission or transport support. Multipart uploads, binary RRD responses
  and WebSocket upgrades are not implemented or validated by this JSON/form client. Do not use
  them until dedicated transport support exists. Guest create, config update, resize, start,
  stop and delete were exercised by the guarded provider live suite. Storage `download-url` and
  volume deletion back `Proxmox.StorageDownload` and passed the guarded live download phase,
  including deletion with a URL-encoded volume ID.

## Opt-in provider live tests

Run `pnpm test:live` only with a dedicated test pool and an explicit allowed VMID range.
Configuration comes entirely from environment variables. See the
[provider setup](../alchemy-proxmox/README.md#run-the-live-suite) for the variables, safety guard
and `pnpm test:live:cleanup` command. This suite never runs as part of `pnpm test`.

The milestone 3 node reported `pve-manager` 9.2.21, `qemu-server` 9.2.11, `pve-container`
6.1.14 and `libpve-guest-common-perl` 6.0.5. The client remains pinned to `pve-docs` 9.2.4.

The suite passed create/start, default retain, updates, disk growth, pending settings, tag-only
adoption, plan errors, protection and destroy for both guest types. Follow-up GETs found the
pool and test-range storage empty. Creation is deliberately untagged in the pool, followed by
a tag-only config update to work around [Proxmox bug 7864](https://bugzilla.proxmox.com/show_bug.cgi?id=7864).

Comma-separated `delete=tags,description` removed both fields on containers and VMs. No form
encoding change was needed. Repeated-key arrays and guest-agent cloud-init completion remain
unverified live because the networkless VM's agent was unavailable. Offline tests cover that
path. The provider normalizes the trailing newline Proxmox adds to descriptions, preventing
perpetual diffs. No schema repin was needed.

## Differences from distilled

The spec mirror is neither a committed directory nor an external Git submodule:
`pnpm specs:fetch` writes it locally, and only its `provenance.json` is committed. Codegen
comes from `@distilled.cloud/core@1.0.0-rc.17`; newer distilled checkouts move it to an
unpublished dev package. No upstream source is vendored. pnpm 12.15.0 is pinned instead of
upstream's 12.9.1.
The Node platform shared package is overridden to 4.0.5 to match Effect and avoid a newer peer
requirement. The provider pins `alchemy@2.0.0-beta.84` and shares the same Effect and core versions.

Core does not model Proxmox indexed families directly. The generator lowers those members to
TypeScript template-key signatures and `StructWithRest` schemas in its final emission pass.
It also replaces core's generated `as any as` assertions with `as unknown as`. The protocol
wraps core's encoder to form-encode requests and retains core's decoder and response validation.
Operation names are deliberately path-derived rather than guessed from upstream's ambiguous
names. These are converter and generator policies, not hand edits to generated services.
