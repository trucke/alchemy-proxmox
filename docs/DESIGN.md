# Design

This document explains how the client and the provider are built and why. The package READMEs
describe how to use them:
[`@distilled.cloud/proxmox`](../packages/proxmox/README.md) and
[`@alchemy.run/proxmox`](../packages/alchemy-proxmox/README.md).

The repository contains two packages:

1. **A Proxmox VE API client** (`@distilled.cloud/proxmox`), generated from Proxmox's own API
   schema. It follows the conventions of `distilled`, the generated SDKs that Alchemy's providers
   are built on.
2. **An Alchemy provider** (`@alchemy.run/proxmox`) for LXC containers, QEMU virtual machines and
   storage downloads. It is built on the client and follows the shape of Alchemy's built-in
   Hetzner provider (`@alchemy.run/hetzner`): it calls only the generated client and handles its
   typed errors.

## Toolchain

Node 24, TypeScript, Effect v4, vitest and pnpm 12.15.0, as in `distilled` and `alchemy`.
Dependencies are pinned exactly: `@distilled.cloud/core` 1.0.0-rc.17 for the runtime and the code
generator, Effect 4.0.5 and `alchemy` 2.0.0-beta.84.

## The client

**Source of truth.** Proxmox publishes its API as JSON Schema in the API viewer's `apidoc.js`
(`const apiSchema = [...]`), shipped in the `pve-docs` package. Version 9.2.4 describes 678 API
calls. A fetch script extracts the array from a pinned `pve-docs` release and writes it
deterministically. Proxmox serves its package repository over plain HTTP, so the script verifies
the signed `InRelease` file with `gpgv` against Proxmox's trixie release key, whose fingerprint
it pins, and follows the signed checksums down to the package. The extracted schema is not
committed (see [Proxmox schema text](#proxmox-schema-text)); its `provenance.json` is.

`pve-docs` can lag behind the installed `pve-manager`, `qemu-server` and `pve-container`.
Parameters that it does not describe are not available until the pinned release is updated.

**Generation.** `scripts/convert.ts` turns the schema tree into Smithy models, as `distilled`
does for other vendors without OpenAPI specs. `scripts/generate.ts` then emits one service module
per API area (`nodes_lxc`, `nodes_qemu`, `nodes_tasks`, `storage`, `pools`, `cluster` and others),
49 in total. Generated files are never edited by hand.

Operation names include the HTTP method and path segments, because Proxmox repeats the same
operation names across unrelated paths. Doc comments name the method and path of each operation,
for example `/** POST /nodes/{node}/lxc */`.

**Property strings.** Settings such as `net0`, `rootfs` and `scsi0` are strings like
`name=eth0,bridge=vmbr0,ip=dhcp`. The schema describes their keys and types (`net[n]` has 15
keys, `scsi[n]` has 50), so the generator emits typed encoders and decoders for these inline
formats. Generated operations still take and return raw strings and keep the format metadata in
Smithy traits.

Some formats have no sub-schema in the viewer. For `pve-qm-ipconfig`, a hand-written structural
schema lists its four keys and types, with pinned qemu-server source as the reference. Other
named formats stay strings, and the provider compares them with a shared tokenizer.

Indexed families use template-key signatures such as `net${number}` and runtime record schemas.
The viewer does not describe how many indexes each family supports, so the server validates that.

**Hand-written parts**, as in every `distilled` package:

- `credentials.ts`: the base URL (`https://<host>:8006/api2/json`), the token ID and secret as
  `Redacted` values and an optional CA certificate. Core has no TLS option, so CA trust is
  configured on the injected HTTP client.
- `protocol.ts`: the `Authorization: PVEAPIToken=<user>@<realm>!<id>=<secret>` header,
  form-encoded bodies, unwrapping of `{ "data": ... }` and mapping of errors into tagged errors.
- `tasks.ts`: most writes return a task ID (UPID). `waitForTask` polls
  `/nodes/{node}/tasks/{upid}/status` with capped backoff until a deadline (2 minutes unless the
  caller passes another one) and fails with `TaskFailed` or `TaskTimeout`. It is modeled on
  Hetzner's `waitForAction`. A task that ends with warnings succeeds and reports the warnings.

## Proxmox schema text

The repository is licensed under Apache-2.0, like `distilled` and `alchemy`. The schema in
`apidoc.js` mixes two kinds of content:

- **Interface structure:** paths, methods, operation names, parameter names, types, formats,
  enums, defaults, constraints and flags.
- **Documentation text:** descriptions, verbose descriptions, format descriptions, type texts,
  titles and permission descriptions, written in Proxmox's Perl sources.

The copyright file of `pve-docs` lists `*.js` under AGPL-3.0-or-later and the documentation
under GFDL-1.3.

The repository keeps only the structure and does not redistribute Proxmox's text. The client
needs only the structure, and the text is Proxmox's documentation. Other projects draw the same
line: `jrjsmrtn/pve-openapi` (Apache-2.0) does not commit generated specs, while
`basher83/Proxmox-OpenAPI` commits specs with descriptions and is licensed under AGPL-3.0.

- `scripts/convert.ts` copies an allowlist of structural keywords into the Smithy models and
  drops every other field. Permission objects are dropped too; the token and protection flags
  remain. Some defaults describe computed behavior in words instead of giving a value, so a string
  default that contains whitespace is dropped.
- Operation doc comments are generated from the method and path. Members have no doc comments.
  Proxmox's [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) documents each call.
- Git ignores `api-schema.json`. `pnpm specs:fetch` downloads and verifies it, and `convert`
  refuses to run when it is missing or its SHA256 differs from `provenance.json`. Installation,
  typecheck, lint, format check and tests work without it.
- `pnpm generate` ends with `pnpm check:prose`. The check collects every schema string with at
  least four words and fails if one appears in a file that is or would be committed. It compares
  lowercase word sequences, so line breaks, comment markers and escapes do not hide a copy.
- Converter tests use invented schema fragments.
- Hand-written docs paraphrase Proxmox behavior instead of quoting its documentation. Short
  error messages from the API stay verbatim, because the client and the tests match them.

Without the descriptions, core's code generator merges shapes with identical bodies. Three
response item shapes in `cluster.ts` and `nodes_qemu.ts` are therefore aliases of other shapes.
Their names and types are unchanged.

## The provider

The provider has three resources: `Proxmox.Container`, `Proxmox.VirtualMachine` and
`Proxmox.StorageDownload` (see [Storage downloads](#storage-downloads)).

Guest props use `node`, `vmid`, a `config` object with API field names and optional `disks`
entries with `storage` and `sizeGiB`. Inline property-string fields accept strings or partial
typed objects. Only declared leaves are compared. The template, the image and the initial SSH
keys are used only at creation and not compared afterwards.

Reads also fetch `/pending`. The comparison uses the effective configuration, including pending
settings. The VM cloud-init password is excluded from attributes and pending values.

**Identity.** A guest is identified by node and VMID, both set explicitly in props. The provider
never picks a VMID.

**Ownership.** A guest managed by Alchemy carries ownership tags. A guest without them reads as
`Unowned`, so taking it over requires `--adopt`. Adoption adds the tags and must change nothing
else: any other difference between props and the guest fails the plan. Tags were chosen over
Alchemy state alone because they still show which guests Alchemy manages if the state is lost.

Ownership uses three plain tags: the marker `alchemy`, the stack name and the stage name, all
lowercase (for example `alchemy`, `web` and `prod`). The stack and stage tags count only next to
the marker:

| Tags on the guest                             | Meaning                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| No `alchemy`                                  | Unmanaged; adopting needs `--adopt`                          |
| `alchemy` with this stack's and stage's names | Owned by this stack and stage                                |
| `alchemy` with other names                    | Owned by another stack or stage; taking over needs `--adopt` |

A stack or stage name that is not a valid Proxmox tag fails the plan. When a guest leaves Alchemy,
only `alchemy` needs to go; the remaining name tags then mean nothing. Taking over a guest from
another stack keeps that stack's name tags. Existing user tags are kept.

Unlike key-value cloud tags, Proxmox tags form a set, so the provider merges the
semicolon-separated list directly instead of using Alchemy's `diffTags`. Alchemy's plan renderer
does not accept provider-defined property changes, so the provider logs the differences it found
before Alchemy's adoption summary.

**Changes.** The provider classifies every declared change:

| Class             | Examples                                                                                                   | Provider behavior                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Live              | `onboot`, `startup`, tags, description, firewall flag, container hostname, name of a VM without cloud-init | Update in place                                               |
| Needs reboot      | Cores, sockets, CPU type, CPU limit and units, balloon, VM memory                                          | Update the config and report the pending change; never reboot |
| Not yet supported | Address, gateway, bridge, moving a disk to other storage, name of a VM with cloud-init                     | Fail the plan                                                 |
| Fixed             | Node, VMID, OS type, architecture, unprivileged, template flag, disk shrink                                | Fail the plan; never replace a guest                          |

Any change that is not classified fails the plan. Disk growth is live and uses the resize API.
VMs therefore import the plain cloud image and grow it after the import; no copies of the image
for each size are needed.

The API allows the "not yet supported" changes. Each one needs its own handling before the
provider can make it safely:

- **Address, gateway and bridge.** DNS records, firewall rules and reverse proxies elsewhere point
  at a guest's address, so changing only the guest breaks those paths. These changes become safe
  once those records are resources in the same stack and one plan changes all of them.
- **Name of a VM with cloud-init.** Proxmox derives the cloud-init hostname from the VM's `name`
  and the cloud-init instance ID from a hash of the generated user and network data
  (`PVE/QemuServer/Cloudinit.pm`). Renaming such a VM changes its instance ID, so cloud-init
  treats the next boot as a new instance and runs its first-boot setup again. Without a
  cloud-init drive, `name` is only Proxmox's label, and the guest's own hostname is untouched. A
  container's hostname is different: Proxmox applies it without a restart
  (`$LXC_FASTPLUG_OPTIONS` in `PVE/LXC/Config.pm`) and manages it inside the container, so it is
  live.
- **Moving a disk to other storage** copies its data and can take a long time.

Proxmox cannot shrink disks at all.

**Removal.** Both guest resources set `defaultRemovalPolicy: "retain"`. Removing a guest from code
makes Alchemy forget it. Deleting a guest requires an explicit `RemovalPolicy.destroy()`, refuses
a guest that has Proxmox's `protection` flag set and destroys its unreferenced disks. Proxmox
reuses VMIDs, so deletion also refuses a guest that no longer carries this stack's ownership tags:
a guest created later under the same VMID is never deleted.

**Creation** requires an explicit `pool`. The provider creates the guest stopped and untagged,
waits for the task and then writes the ownership tags and the declared tags in a separate config
update. A VM `image` is imported into `disks.scsi0`, and the resize API then grows it to the
declared size. Optional `cloudInitStorage` creates an `ide2` cloud-init drive. The guest then
starts, unless `startAfterCreate: false` is declared. This setting applies only to creation:
updates and adoption never start or restart existing guests.

Tagging is a separate step because a pool-scoped token cannot set tags during creation. The
[container permission check](https://github.com/proxmox/pve-container/blob/master/src/PVE/LXC.pm)
passes tags to
[`assert_tag_permissions`](https://github.com/proxmox/pve-guest-common/blob/master/src/PVE/GuestHelpers.pm),
which checks `/vms/<vmid>` without the pool. A permission on the pool therefore does not cover
tags until the guest is a member of the pool. This is
[Proxmox bug 7864](https://bugzilla.proxmox.com/show_bug.cgi?id=7864). The provider uses the same
path for every token, with no shortcut for more privileged tokens, so it needs no broader
permissions.

An interruption before tagging leaves an unowned guest. The plan then fails without `--adopt`;
the provider names the possible interruption, and Alchemy's error explains how to adopt.
Adoption only adds the ownership tags: it never resumes disk growth or starts the guest. To
recover, match the declaration to the guest, omit capacity and tag declarations that do not match
yet and apply them in a later update.

**Cloud-init wait.** VMs can opt in to `waitForCloudInit`. The provider waits up to one minute
for the guest agent to answer a ping, starts `cloud-init status --wait` once and polls the
command's status for up to five minutes. Each exec request has a 30-second deadline. Any nonzero
exit, including cloud-init's degraded status, fails. Guest command output is never logged.

**Writes** read the guest again instead of trusting the previous props. Partial property strings
are merged with the observed values. Config writes pass the observed digest, so a concurrent
change makes the write fail instead of being overwritten. Disk growth follows the config write.
Every task is awaited, and warnings are logged. Reads after writes return the actual `/pending`
entries. Proxmox appends a newline to descriptions, so the comparison ignores trailing newlines,
while attributes keep the API's value.

Deletion stops a running guest and destroys its unreferenced disks. Its requests carry only the
guest's identity (node and VMID), never the full resource attributes. It never passes `purge`,
force or lock-bypass flags. Removing the guest from backup, replication or high availability
configuration is outside this lifecycle. Deleting a missing guest does nothing.

**Credentials** use Alchemy's `makeStoredAuthProvider` with endpoint, token ID, token secret and
optional CA certificate, stored in an Alchemy profile. CI reads `PROXMOX_ENDPOINT`,
`PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` and `PROXMOX_CA_CERT` instead.

## Storage downloads

`Proxmox.StorageDownload` downloads a container template, ISO image or VM disk image onto a
node's storage with `POST /nodes/{node}/storage/{storage}/download-url` and waits for the task.
Downloads can take minutes, so the wait is limited by `timeoutMinutes` (default 30).

- **Checksums are required.** `checksum` and `checksumAlgorithm` are mandatory, and
  `verifyCertificates` defaults to true. Proxmox verifies the file before it becomes visible.
- **Identity** is node, storage, content and filename. The `volid` attribute
  (`<storage>:<content>/<filename>`) is what a container `template` or VM `image` references.
  Filenames must already be in Proxmox's normalized form, so the volume ID cannot change.
- **Ownership.** Files cannot carry tags. A file recorded in Alchemy state is owned; any other
  existing file reads as `Unowned`, so taking it over needs `--adopt`. The content listing reports
  no checksum, so adoption cannot verify the file's content.
- **Changes.** A different node, storage, content or filename is a replacement: a new file is
  downloaded, and the old one follows the removal policy. A changed `url`, checksum or
  `compression` for the same filename fails the plan with `UnsafeStorageDownloadChange`, because
  Proxmox never overwrites a file and the content cannot be compared. Certificate verification
  and the timeout affect only the download and are not compared.
- **Removal.** `defaultRemovalPolicy: "retain"`. Files carry no ownership marker, and deletion
  needs `Datastore.Allocate`, which covers every volume on the storage. With
  `RemovalPolicy.destroy()`, deletion calls
  `DELETE /nodes/{node}/storage/{storage}/content/{volume}` and waits for the task. A missing file
  counts as deleted. Deletion identifies the file only by its volume ID.
- **Interrupted downloads.** A timeout fails the deployment, while the Proxmox task keeps running.
  A file that the task completes later has no Alchemy state and needs `--adopt`. A replacement
  onto an existing filename fails with `StorageDownloadConflict` instead of claiming the file.

Downloads need `Datastore.AllocateTemplate` on the storage and `Sys.AccessNetwork` on the node.
A restricted token should manage a dedicated download storage that holds nothing else.

## What an API token cannot do

What a pool-scoped API token on Proxmox VE 9.2 can and cannot do:

| Need                                                                            | Result                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Container with `nesting`                                                        | Works                                                                                        |
| VM disk imported from `local:import`, cloud-init drive, existing vendor snippet | Works                                                                                        |
| NIC on a bridge                                                                 | Needs `SDN.Use` on `/sdn/zones/localnetwork/<bridge>`                                        |
| Device passthrough (`dev[n]`, for example `/dev/net/tun`)                       | Refused: `root@pam` only                                                                     |
| Writing cloud-init snippets                                                     | No API; upload accepts only `iso`, `vztmpl` and `import`                                     |
| Downloading templates and images                                                | API `download-url` with checksum; needs `Datastore.AllocateTemplate` and `Sys.AccessNetwork` |

Device passthrough and snippet files therefore stay outside the provider. The provider reads both
and fails the plan if they differ, so it never silently drops them.

Both would need root access to the node:

- **Device passthrough.** Proxmox skips its permission check only when the authenticated user is
  exactly `root@pam` (`check_ct_modify_config_perm` in `PVE/LXC.pm`). A request with an API token
  authenticates as the token, so even a `root@pam` token is refused; the
  [`bpg/proxmox` docs](https://registry.terraform.io/providers/bpg/proxmox/latest/docs) describe
  the same behavior. The options are a `root@pam` password login (an API ticket) or
  `pct set <vmid> --dev0 ...` over SSH as root.
- **Snippet files.** The API cannot write them;
  [Proxmox Bugzilla #2208](https://bugzilla.proxmox.com/show_bug.cgi?id=2208) tracks adding that.
  The only option is SSH or SFTP to the node's storage.

The Terraform provider `bpg/proxmox` works this way: an optional SSH connection for snippets and
a password login for operations that API tokens cannot do. Either option means the provider
holds a root password or root SSH key for the node, so it would need its own design.

## Testing

- **Client:** converter tests (invented schema fragments to Smithy), protocol tests (header, form
  encoding, envelope and errors) and task polling against recorded responses. They make no live
  calls. `pnpm check:prose` runs with `pnpm generate`, because it needs the fetched schema.
- **Provider:** unit tests for change classification, property strings, creation, interrupted
  creation, updates, deletion, the cloud-init wait and storage downloads, against constructed
  responses.
- **Live suite:** an opt-in suite against a real node, with a token that may change guests only
  inside a dedicated pool. Proxmox enforces that boundary. In addition, a local HTTPS proxy checks
  the node, the VMID range and pool membership before every write, from both direct client calls
  and the Alchemy CLI. An optional phase downloads one `alchemy-test-` container template to a
  dedicated storage and deletes it; the proxy allows no other storage writes. Read requests after
  teardown confirm that the pool and the test storage are empty.

## Open questions

- **More named formats.** Add hand-written schemas for named property-string formats beyond
  `ipconfig[n]` when they are needed. Syntax validation stays on the server.
- **More update classes.** Enable each further change only after a dedicated live test. Changes
  that are not classified keep failing the plan.
- **Array encoding.** Repeated-key array encoding needs a live confirmation through a successful
  write that carries an array.
- **Ownership marker.** Whether ownership tags are the right marker, or Alchemy state alone should
  decide ownership. Tags survive lost state but change the guest during adoption.
- **Verifying adopted files.** Proxmox's `download_file_from_url` (`PVE/Tools.pm`) hashes an
  existing file when a checksum is given: a match succeeds without downloading, and a mismatch
  fails. Calling `download-url` during adoption could therefore check the content. It needs the
  download privileges and has not been tested against a node.
