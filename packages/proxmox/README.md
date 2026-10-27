# @distilled.cloud/proxmox

Effect v4 client for the Proxmox VE API, generated from the API schema in Proxmox's `pve-docs`
9.2.4 package: 678 operations in 49 modules, with typed codecs for property strings. It is not on
npm yet. The [Alchemy provider](../alchemy-proxmox/README.md) builds on it.

## Use the client

The package is not on npm yet, so use it from a clone of the repository (see
[Try it](../../README.md#try-it)). This program lists all guests and counts the settings in each
guest's configuration:

```ts
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Proxmox from "@distilled.cloud/proxmox";
import { nodeLayer } from "@distilled.cloud/proxmox/node";

const program = Effect.gen(function* () {
  const guests = yield* Proxmox.cluster.getClusterResources({ type: "vm" });
  for (const guest of guests) {
    if (!guest.node || !guest.vmid) continue;
    const input = { node: guest.node, vmid: guest.vmid };
    if (guest.type === "lxc") {
      const config = yield* Proxmox.nodesLxc.getNodesByNodeLxcByVmidConfig(input);
      console.log(guest.vmid, "container", Object.keys(config).length);
    } else if (guest.type === "qemu") {
      const config = yield* Proxmox.nodesQemu.getNodesByNodeQemuByVmidConfig(input);
      console.log(guest.vmid, "vm", Object.keys(config).length);
    }
  }
});

const exit = await Effect.runPromiseExit(
  Effect.flatMap(Proxmox.configFromEnv, (config) =>
    program.pipe(Effect.provide(nodeLayer(config))),
  ),
);
if (Exit.isFailure(exit)) {
  // A raw HTTP error contains the request, including the token. Print only a summary.
  console.error(Proxmox.describeError(Cause.squash(exit.cause)));
  process.exitCode = 1;
}
```

Save it as `packages/proxmox/example.ts`, set the
[authentication variables](../alchemy-proxmox/README.md#authentication) and run it from the
repository root:

```sh
node --experimental-transform-types packages/proxmox/example.ts
```

`Proxmox.configFromEnv` reads the variables, and `nodeLayer(config)` provides an HTTP client that
verifies the certificate and hostname.

Operation names combine the HTTP method and the path, because Proxmox reuses operation names on
different paths. Each operation's doc comment shows its method and path, for looking it up in
Proxmox's [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/).

## Check a token

`pnpm smoke` lists all guests and reads their configurations with GET requests only. It prints a
short line per guest, never whole configurations or credentials. Run it from the repository root
with the variables above set:

```sh
pnpm smoke
```

On failure, it prints only the error type and HTTP status, for example
`Smoke failed: Forbidden (HTTP 403)`.

## Property strings

Many Proxmox settings are strings of comma-separated keys, such as
`name=eth0,bridge=vmbr0,ip=dhcp`. The client generates a codec for each of them:

```ts
import { nodes_lxc } from "@distilled.cloud/proxmox/property-strings";

const network = nodes_lxc.PutNodesByNodeLxcByVmidConfigRequest["net[n]"];
const wire = network.encode({ name: "eth0", ip: "dhcp", firewall: true });
const parsed = network.decode(wire);
```

Generated operations take and return the raw strings; use the codecs to convert them. A few
formats that the schema describes only by name, such as `pve-vm-cpu-conf`, stay plain strings.

## Errors

| Proxmox response                         | Client error                                       |
| ---------------------------------------- | -------------------------------------------------- |
| HTTP 400 with per-parameter errors       | `ParameterValidationError`                         |
| HTTP 500 for a guest that does not exist | `GuestNotFound` (Proxmox does not return 404 here) |
| Other error statuses                     | Tagged status errors, such as `Forbidden`          |
| Unknown status                           | `UnknownProxmoxError`                              |

Do not print or log raw errors: an HTTP error contains the request with the token in its
`Authorization` header, and response bodies can contain secrets. `describeError(error)` returns a
safe summary with only the error type and HTTP status, as in the example above.

Most write operations return a task ID. `waitForTask(node, upid, { timeout })` waits for the task
(by default up to 2 minutes) and fails with `TaskFailed` or `TaskTimeout`.

## Limits

- Array parameters are sent as repeated keys, which has not been tested against a live node yet.
- File uploads, binary responses and WebSocket endpoints are not supported.
- Having an operation in the client does not mean a token may call it; some are root-only.

## Develop and regenerate

Requires Node 24 and pnpm 12.15.0. Fetching the schema also requires `gpgv`, `ar` and `tar`. Run
these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm specs:fetch   # download and verify the pinned schema
pnpm generate      # regenerate src/services and check for Proxmox text
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

The generated code is committed, so installing and the checks work without the schema. Never edit
files in `src/services/` by hand.

`pnpm specs:fetch` downloads `pve-docs` 9.2.4, verifies it against Proxmox's signed package
repository and writes the schema next to `provenance.json`. Git ignores the schema itself.

The repository contains no Proxmox documentation text. After editing docs, run
`pnpm check:prose`, which fails if a schema description appears in a committed file. It needs the
fetched schema, so run `pnpm specs:fetch` first.
[docs/DESIGN.md](../../docs/DESIGN.md#proxmox-schema-text) explains why and how the download is
verified.
