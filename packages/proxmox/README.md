# @distilled.cloud/proxmox

Effect v4 client for the Proxmox VE API, generated from the API schema in Proxmox's `pve-docs`
9.2.4 package. It has 678 operations in 49 modules and typed codecs for property strings. The
package is not published to npm yet. The [Alchemy provider](../alchemy-proxmox/README.md) builds
on it.

## Use the client

This program lists all guests and counts the keys in each guest's configuration:

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

Operation names combine the HTTP method and the path, because Proxmox reuses the same operation
names on unrelated paths. Each operation's doc comment names its method and path, so you can
look it up in Proxmox's [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/).

`Proxmox.configFromEnv` reads `PROXMOX_ENDPOINT`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` and
the optional `PROXMOX_CA_CERT` (PEM contents, not a file name). `credentials(config)` accepts the
same values directly: an endpoint, a redacted token ID, a redacted token secret and an optional CA
PEM. `CredentialsFromEnv` provides the credentials service from the environment.

`nodeLayer(config)` also provides a Node HTTP client with certificate and hostname verification
enabled. A custom HTTP client must configure CA trust itself. Callers do not need to provide
`ProxmoxProtocol`; each generated operation carries it.

## Run a read-only smoke check

The smoke script checks a token and a node with GET requests only. It does not start tasks or
change guests. The token needs permission to list guests and read their configurations.

1. Set `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET` from your secret manager. Do not put their
   values in command arguments or source files.
2. Set the endpoint and, for a private CA, the CA certificate:

   ```sh
   export PROXMOX_ENDPOINT='https://pve.example.com:8006'
   export PROXMOX_CA_CERT="$(< /path/to/ca.pem)"
   ```

   Use the DNS name that the node's certificate covers, not its IP address.

3. From the repository root, run the script:

   ```sh
   pnpm smoke
   ```

The script lists guests with `/cluster/resources?type=vm` and reads each container or VM
configuration. For each guest, it prints the VMID, type, name, node, status, cores, memory in MiB
and the number of configuration keys. It never prints whole configurations. At the end, it prints
the number of configurations read.

On failure, the script prints only the error tag, the transport reason and the HTTP status, for
example `Smoke failed: Forbidden (HTTP 403)`. It never prints requests, headers, response bodies
or credentials.

## Property-string codecs

`pnpm generate` also emits `src/property-strings.ts` from the schema's inline `format`
definitions. Codecs are grouped by service, operation shape and field. Indexed families such as
`net[n]` share one codec for every index:

```ts
import { nodes_lxc, nodes_qemu } from "@distilled.cloud/proxmox/property-strings";

const network = nodes_lxc.PutNodesByNodeLxcByVmidConfigRequest["net[n]"];
const wire = network.encode({ name: "eth0", ip: "dhcp", firewall: true });
const parsed = network.decode(wire);
const memory = nodes_qemu.PutNodesByNodeQemuByVmidConfigRequest.memory.decode("2048");
// memory.current === 2048
```

The codecs handle required and optional keys, numbers, booleans, unnamed default keys and
aliases, including network model aliases such as `virtio=<MAC>`. Encoding uses the canonical key
names. Duplicate keys, malformed values and ambiguous delimiters fail, and the errors do not
include the values. Omitted defaults are not filled in. The server still validates patterns,
numeric ranges and supported indexes.

The schema describes some formats only by name. These stay plain strings, with one exception:
`scripts/property-formats.ts` adds the structure of `pve-qm-ipconfig` (the optional string keys
`ip`, `gw`, `ip6` and `gw6`), taken from
[qemu-server's source](https://git.proxmox.com/?p=qemu-server.git;a=blob;f=src/PVE/QemuServer/Network.pm;hb=71ea0ac7192bb935f63cb64beb59e87d6cecd3bf).
It uses the same codec as the inline formats. Formats such as `pve-qm-cicustom`,
`pve-vm-cpu-conf` and `pve-startup-order` remain strings.

## Errors

| Proxmox response                                                                | Client error                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| HTTP 400 with an `errors` object                                                | `ParameterValidationError`, with per-parameter messages |
| HTTP 500 with the message `Configuration file '...' does not exist` for a guest | `GuestNotFound`                                         |
| Other HTTP error statuses                                                       | Core's tagged status errors, such as `Forbidden`        |
| Unknown status                                                                  | `UnknownProxmoxError`                                   |
| Response that fails the optional strict validation                              | `ProxmoxParseError`                                     |

Proxmox reports a missing guest as HTTP 500, not 404. Other HTTP 500 responses keep core's
server error.

API responses can contain secrets, so do not log error bodies. `describeError(error)` returns a
log-safe summary with only the error tag and the HTTP status.

Response validation is lenient by default. Core's `ResponseValidation.strict` and
`ResponseValidation.additionalProperties` layers make it stricter. Enums accept unknown values at
runtime, so new Proxmox values do not break responses.

## Wire behavior and limits

- Requests authenticate with `Authorization: PVEAPIToken=<token-id>=<secret>`.
- Request bodies are form encoded. Booleans become `0` or `1`, also in query parameters. Arrays
  use repeated keys, which has not been tested against a live node yet. A `delete` list is a
  comma-separated string, not an array.
- Responses are unwrapped from `{ "data": ... }`. Boolean flags in responses keep their wire form,
  `boolean | 0 | 1`. Property strings stay raw strings; decode them with the codecs above.
- Value types can differ between guest types: a VM's `memory` is a string (it is a property
  string), a container's is a number.
- Indexed parameters have template-key types such as `net${number}`. The schema does not state
  how many indexes each family supports, so the server enforces that.
- `waitForTask(node, upid, { timeout })` polls a task with exponential backoff from 500 ms up to
  5 s, until the timeout (default 2 minutes). `OK` succeeds with `warnings: 0`, and
  `WARNINGS: <n>` succeeds with that count. Other results fail with `TaskFailed`, and the timeout
  fails with `TaskTimeout`. Transport errors are not retried.
- The client includes every operation in the schema, including root-only operations. Having an
  operation does not mean a token may call it. Multipart uploads, binary RRD responses and
  WebSocket connections are not supported by this JSON and form client.

## Develop and regenerate

Requires Node 24 and pnpm 12.15.0. `pnpm specs:fetch` also requires `gpgv` (GnuPG), `ar` and a
`tar` that supports the Debian package's compression. Run these commands from the repository
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
      (`24B30F06ECC1836A4E5EFECBA7BCD1420BFE778E`, as listed on Proxmox's ISO download pages).
      It reads only the signed text.
   3. It checks the `trixie/pve-no-subscription` package index, compressed and uncompressed,
      against the SHA256 and size listed in `InRelease`.
   4. It finds `pve-docs` 9.2.4 in that index and checks the `.deb` against the entry's SHA256.

   The script then extracts the JSON array from `apidoc.js` without executing JavaScript and
   checks that it contains 678 operations. It writes `api-schema.json` and `provenance.json` to
   `specs/spec-mirror-proxmox/specs/`. Git ignores `api-schema.json`; only `provenance.json` is
   committed. It records the URLs, the verified `InRelease` (SHA256, date, key URL and
   fingerprint), the package index entry and the SHA256 checksums of the index, the package,
   `apidoc.js` and the JSON payload. Running the script again produces the same
   `api-schema.json`. The `release` fields and the index checksum change whenever Proxmox
   publishes a new package index.

3. Convert and generate:

   ```sh
   pnpm convert
   pnpm generate
   ```

   `convert` writes Smithy models to `.generated-specs/`. It stops with an instruction to run
   `pnpm specs:fetch` when the schema is missing or its SHA256 differs from `schemaSha256` in
   `provenance.json`. `generate` runs the conversion again, compiles the models with the pinned
   `@distilled.cloud/core` code generator and formats the TypeScript output in `src/services/`.
   It ends with `pnpm check:prose` (see [Doc comments](#doc-comments)). Never edit generated
   files. Regenerating from the same schema leaves every generated file unchanged.

   The models and services are committed, so installing and the checks below need neither the
   schema nor network access to Proxmox.

4. Check the result:

   ```sh
   pnpm typecheck
   pnpm lint
   pnpm format:check
   pnpm test
   ```

   Typechecking includes every generated service. Tests use a mocked HTTP client, not a live
   node.

The provider's [live suite](../alchemy-proxmox/README.md#run-the-live-suite) tests against a real
node. It never runs as part of `pnpm test`.

### Doc comments

Generated operations have doc comments that name only the HTTP method and path, for example
`/** POST /nodes/{node}/lxc */`. Request and response members have none. Proxmox's descriptions
are part of its own documentation, and this repository does not redistribute them.

`scripts/convert.ts` copies only structural schema keywords into the models: types, formats,
enums, defaults, constraints and flags. `pnpm check:prose` collects every schema string with at
least four words and fails if one appears in a file that Git tracks or would track. It prints the
number of strings and files it scanned and the number of matches. It needs the fetched schema.
Run it after editing docs:

```sh
pnpm check:prose
```

Tests and the error mapping contain a few verbatim Proxmox API error messages, such as
`Parameter verification failed.`, because the client matches them. See
[the design](../../docs/DESIGN.md#proxmox-schema-text) for the reasoning.

### Generator notes

- The code generator is `@distilled.cloud/core` 1.0.0-rc.17. Effect and
  `@effect/platform-node` are pinned to 4.0.5.
- Core does not model Proxmox's indexed families such as `net[n]`. The generator emits them as
  TypeScript template-key signatures and `StructWithRest` schemas.
- The generator replaces core's `as any as` assertions with `as unknown as`.
- The protocol wraps core's encoder to form-encode requests and uses core's decoder and response
  validation.
- These are rules in the converter and the generator. Generated services are never edited by
  hand.
