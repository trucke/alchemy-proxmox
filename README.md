# alchemy-proxmox

Proxmox VE support for [Alchemy](https://alchemy.run): an Effect client for the Proxmox VE API and
an Alchemy provider for LXC containers, QEMU virtual machines and storage downloads built on it.

**Status:** early and unreleased. Nothing is published to npm, and the API can still change.

- The Effect client is generated from `pve-docs` 9.2.4 (678 operations). The schema fetch
  verifies Proxmox's signed repository index.
- `Proxmox.Container` and `Proxmox.VirtualMachine` plan, create, update in place, adopt and
  delete guests. `Proxmox.StorageDownload` downloads templates and images onto a node's storage.
- A guarded live suite passes against a Proxmox VE 9.2 node with a pool-scoped API token.
  Waiting for cloud-init through the guest agent is implemented but not verified live.

See [the provider README](packages/alchemy-proxmox/README.md).

The plan is to offer the client to [`alchemy-run/distilled`](https://github.com/alchemy-run/distilled) (see
[distilled#856](https://github.com/alchemy-run/distilled/issues/856)) and the provider to
[`alchemy-run/alchemy`](https://github.com/alchemy-run/alchemy).

## Design rules

- The client is generated from Proxmox's own API schema, following `distilled`'s conventions.
  Proxmox publishes that schema as JSON Schema inside the API viewer's `apidoc.js`; each generated
  client pins the Proxmox VE release it came from. No hand-written API client.
- The repository keeps only the schema's structure. The schema itself is fetched and verified
  before generation instead of being committed. Generated code has no Proxmox doc comments.
  See [License](#license).
- Guests and downloaded files are retained by default (`defaultRemovalPolicy: "retain"`).
  Removing one from code makes Alchemy forget it; deleting it takes an explicit
  `RemovalPolicy.destroy()`.
- A change that would require replacing a guest fails the plan instead of destroying the guest.
  A download is replaced only when its file name or location changes; a changed source for the
  same file fails the plan.
- Existing guests and files are adopted only with `--adopt`. Adopting a guest adds the
  ownership tags and changes nothing else. Adopting a file changes nothing and cannot verify
  its content.

See [docs/DESIGN.md](docs/DESIGN.md) for the full design.

- Credentials are a Proxmox API token from an Alchemy profile or, in CI, environment variables.
  Operations that Proxmox allows only for `root@pam` are out of scope until a separate, explicit
  design covers them.

## Read-only checks

List guests and read their configs on an existing Proxmox VE 9.2 node with a token,
using only GET requests. See [the client README](packages/proxmox/README.md) for setup,
regeneration and the smoke script. Provider `read` and `diff` support `alchemy plan --adopt`.
Inline property-string schemas generate typed codecs. `ipconfig[n]` uses a supplemental
schema from pinned upstream source; other named formats without sub-schemas remain strings.

## Testing

`pnpm test` runs offline converter, protocol, property-string, task-polling, provider policy and storage download tests. `pnpm typecheck`
checks generated code as well as hand-written code. `pnpm smoke` is a separate GET-only
live check, not part of the test suite. None of these need the fetched schema. `pnpm generate`
does: run `pnpm specs:fetch` first. Generation ends with `pnpm check:prose`, which fails if
Proxmox schema text appears in the repository.

`pnpm test:live` is an opt-in suite with a dedicated pool, an explicit VMID range and a guard
before every write. `pnpm test:live:cleanup` removes leftover guests only when both boundaries
match. A download phase runs only when its own variables are set, and the guard limits it to
`alchemy-test-` templates on a dedicated storage. Neither command runs under `pnpm test`. See the
[live test setup](packages/alchemy-proxmox/README.md#run-the-live-suite) and the
[permissions guide](packages/alchemy-proxmox/README.md#permissions-reference).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The client is generated from the Proxmox VE API schema in Proxmox's `pve-docs` package
(AGPL-3.0-or-later). This repository keeps only structural interface information from that
schema (paths, methods, parameter names, types and constraints) and no Proxmox
documentation text. `pnpm specs:fetch` downloads and verifies the schema; it is not committed.
See [Proxmox schema text](docs/DESIGN.md#proxmox-schema-text) for the reasoning and the checks.
