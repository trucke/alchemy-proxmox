# Design

**Status:** draft. Decisions are recorded where they apply.

This repository builds two things, in this order:

1. **A Proxmox VE API client** in the shape of an `alchemy-run/distilled` package
   (`@distilled.cloud/proxmox`), generated from Proxmox's own API schema.
2. **An Alchemy provider** for LXC containers, QEMU virtual machines and storage downloads, built
   on that client and shaped like Alchemy's built-in Hetzner provider (`@alchemy.run/hetzner`).

Both follow the upstream conventions from day one so that they can be offered upstream without a
rewrite. Upstream Alchemy accepts only providers that call a generated `distilled` client and handle
its typed errors.

## Toolchain

Node 24, TypeScript, Effect v4 and vitest, following `distilled` and `alchemy`. Incubation pins
pnpm 12.15.0 (the installed version) rather than upstream's 12.9.1. Dependencies are pinned
exactly, including `@distilled.cloud/core@1.0.0-rc.17` for runtime and codegen. The workspace
contains `packages/proxmox` and `packages/alchemy-proxmox`. The provider pins
`alchemy@2.0.0-beta.84`, sharing Effect 4.0.5 and distilled core 1.0.0-rc.17 with the client.

## The client

**Source of truth.** Proxmox publishes its API as JSON Schema in the API viewer's `apidoc.js`
(`const apiSchema = [...]`), shipped in the `pve-docs` package. Version 9.2.4 describes 678 API
calls. A fetch script extracts the array from a pinned `pve-docs` release and writes it
deterministically; this becomes the spec mirror. The repository is served over plain HTTP, so
the script verifies the signed `InRelease` with `gpgv` against Proxmox's trixie release key,
whose fingerprint it pins, and follows the signed hashes down to the package. The extracted
schema is not committed (see [Proxmox schema text](#proxmox-schema-text)); `provenance.json`
is. `pve-docs` can lag the installed `pve-manager`, `qemu-server` and `pve-container`;
parameters it does not describe are not available until the mirror is refreshed.

**Generation.** A custom `scripts/convert.ts` turns the schema tree into Smithy models, as
`distilled` already does for non-OpenAPI vendors (Railway's GraphQL, Celld's hand-authored models).
`scripts/generate.ts` then emits one service file per API area (`nodes_lxc`, `nodes_qemu`,
`nodes_tasks`, `storage`, `pools`, `cluster`, ...). Generated files are never edited by hand.
The implementation has 49 service modules. Operation names include HTTP method and path
segments because the upstream operation names repeat across unrelated routes. Doc comments
name the HTTP method and path of each operation, for example `/** POST /nodes/{node}/lxc */`.
The spec mirror is neither a committed directory nor a Git submodule: `pnpm specs:fetch`
writes it locally before `pnpm generate`.

**Property strings.** Settings such as `net0`, `rootfs` and `scsi0` are strings like
`name=eth0,bridge=vmbr0,ip=dhcp`. The schema describes their keys and types (`net[n]` has 15 keys,
`scsi[n]` 50), so milestone 2 generates typed encoders and decoders for inline formats. Generated API operations
still expose raw strings and retain format metadata in Smithy traits. `pve-qm-ipconfig` has no
sub-schema in the viewer, so a hand-written structural schema lists its four keys and types,
with pinned qemu-server source as the reference. Other named formats use a shared tokenizer
for declared strings; their typed codecs remain open. Indexed families use template-key
signatures such as `net${number}` and runtime record schemas; family bounds remain
server-validated because the viewer does not describe them consistently.

**Hand-written parts**, as in every `distilled` package:

- `credentials.ts`: base URL per node (`https://<host>:8006/api2/json`), token ID and secret as
  `Redacted`, optional CA certificate. Core has no TLS option, so trust is configured on the injected
  HTTP client.
- `protocol.ts`: `Authorization: PVEAPIToken=<user>@<realm>!<id>=<secret>`, form-encoded bodies,
  unwrapping of `{ "data": ... }`, error mapping into tagged errors.
- `tasks.ts`: most writes return a task ID (UPID). `waitForTask` polls
  `/nodes/{node}/tasks/{upid}/status` with capped backoff until a wall-clock deadline (2 minutes
  unless the caller passes a longer one) and fails with typed `TaskFailed` or `TaskTimeout`,
  modelled on Hetzner's `waitForAction`. A task that ends with warnings still succeeds; its
  warnings are surfaced.

## Proxmox schema text

The repository is meant to be published under Apache-2.0, like `distilled` and `alchemy`. The
schema in `apidoc.js` mixes two kinds of content. The interface structure is paths, methods,
operation names, parameter names, types, formats, enums, defaults, constraints and flags. The
documentation text is descriptions, verbose descriptions, format descriptions, type texts, titles
and permission descriptions, written in Proxmox's Perl sources. The copyright file of
`pve-docs` lists `*.js` under AGPL-3.0-or-later and the documentation under GFDL-1.3.

Decided: the repository keeps only the structure and does not redistribute Proxmox's prose. The
client needs only the structure, and the prose is Proxmox's documentation. The same split shows in
other projects: `jrjsmrtn/pve-openapi` (Apache-2.0) does not commit generated specs, while
`basher83/Proxmox-OpenAPI` commits specs with descriptions and is AGPL-3.0.

- `scripts/convert.ts` copies an allowlist of structural keywords into the Smithy models and
  drops every other field. Permission objects are dropped too; the token and protection flags
  remain. Some defaults describe computed behavior in words instead of giving a value; a
  string default that contains whitespace is dropped.
- Operation doc comments are generated from the method and path. Members have no doc comments.
  Proxmox's [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) documents each call.
- `api-schema.json` is ignored by Git. `pnpm specs:fetch` downloads and verifies it, and
  `convert` refuses to run when it is missing or its SHA256 differs from `provenance.json`.
  Installation, typecheck, lint, format check and tests work without it.
- `pnpm generate` ends with `pnpm check:prose`. The check collects every schema string with at
  least four words and fails if one appears in a file that is or would be committed. It compares
  lowercase word sequences, so line breaks, comment markers and escapes do not hide a copy.
- Converter tests use invented schema fragments.
- Hand-written docs paraphrase Proxmox behavior instead of quoting its documentation. Short
  error messages recorded from a live node stay verbatim because the client and the tests
  match them.

Dropping the text changed no types or wire behavior. With comments removed, 48 of the 50 files in
`src/services/` are identical to the previous output. In `cluster.ts` and `nodes_qemu.ts`, three
response item shapes became aliases: core's codegen merges shapes with identical bodies, and
their descriptions had kept them apart. Their names and types are unchanged; at runtime they
share the schema of the shape they alias, including its identifier annotation.

## The provider

Three resources: `Proxmox.Container`, `Proxmox.VirtualMachine` and `Proxmox.StorageDownload`
(see [Storage downloads](#storage-downloads)).

Milestone 2 implemented `read` and `diff`. Milestone 3 adds reconcile and delete handlers,
validated by the guarded live suite for both resources.
Props use `node`, `vmid`, a `config` object with API field names and optional `disks` entries
with `storage` and `sizeGiB`. Inline property-string fields accept strings or partial typed
objects. Only declared leaves are compared. Create-only template, image and initial public
keys are not compared after creation. Unclassified changes fail closed.

Reads also fetch `/pending`. Plans report existing pending keys and never reboot. The config
comparison uses the API's effective configuration, including pending settings. The VM
cloud-init password is excluded from attributes and pending values.

**Identity.** A guest is identified by node and VMID, both set explicitly in props. The provider
never picks a VMID.

**Ownership.** An Alchemy-managed guest carries ownership tags. A guest without them reads as
`Unowned`, so taking it over requires `--adopt`. Adoption adds the tags and must change nothing
else: any other difference between props and the live guest fails the plan. Decided: tags. If
Alchemy's state is lost, the tags still show which guests it manages.

Ownership uses three plain tags: the marker `alchemy`, the stack name and the stage name, all
lowercase (for example `alchemy`, `homelab`, `prod`). The stack and stage tags count only next to
the marker:

| Tags on the guest                             | Meaning                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| No `alchemy`                                  | Unmanaged; adopting needs `--adopt`                          |
| `alchemy` with this stack's and stage's names | Owned by this stack and stage                                |
| `alchemy` with other names                    | Owned by another stack or stage; taking over needs `--adopt` |

A stack or stage name that is not a valid Proxmox tag fails the plan. When a guest leaves Alchemy,
only `alchemy` needs to go; the leftover name tags then mean nothing. Taking over a guest from
another stack keeps that stack's name tags. Existing user tags are retained. Unlike key/value cloud tags, Proxmox tags form a set, so
the provider merges the semicolon-separated list directly rather than using `diffTags`.
Alchemy's plan renderer does not accept provider-defined property deltas; the provider logs
its observed-to-declared changes before the standard adoption summary.

**Changes.** Each prop is classified, extending the classes of the operator CLI this replaces:

| Class             | Examples                                                                                                   | Provider behavior                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Live              | `onboot`, `startup`, tags, description, firewall flag, container hostname, name of a VM without cloud-init | Update in place                                                                          |
| Needs reboot      | cores, memory (VM), CPU type                                                                               | Update the config; report the pending change from `/pending`; never reboot automatically |
| Not yet supported | address, gateway, bridge, moving a disk to other storage, name of a VM with cloud-init                     | Fail the plan in v1                                                                      |
| Fixed             | node, VMID, OS type, template or image, unprivileged, disk shrink                                          | Fail the plan; never replace a guest                                                     |

Disk growth uses the resize API. VMs therefore import the plain cloud image and are resized after
import; no per-size image copies are needed.

"Not yet supported" changes are possible through the API. They are enabled one at a time, each
after it passes in the test pool:

- **Address, gateway, bridge.** DNS records, firewall rules and reverse proxies elsewhere point at a
  guest's address, so changing only the guest breaks those paths. These changes become safe once
  those records are resources in the same stack and one plan changes all of them.
- **Name of a VM with cloud-init.** Proxmox derives the cloud-init hostname from the VM's `name`,
  and the cloud-init instance ID from a hash of the generated user and network data
  (`PVE/QemuServer/Cloudinit.pm`). Renaming such a VM changes its instance ID, so cloud-init
  treats the next boot as a new instance and re-runs its first-boot setup. Without a cloud-init
  drive, `name` is only Proxmox's label and the guest's own hostname is untouched.
- **Container hostname** is live: Proxmox applies it without a restart (`$LXC_FASTPLUG_OPTIONS` in
  `PVE/LXC/Config.pm`) and manages the hostname inside the container.
- **Moving a disk to other storage** copies its data and can take long.
- Proxmox cannot shrink disks at all.

**Removal.** Both resource types set `defaultRemovalPolicy: "retain"`. Removing a guest from code
makes Alchemy forget it. Deleting a guest requires an explicit `RemovalPolicy.destroy()`, refuses a
guest that has Proxmox's `protection` flag set, and destroys its unreferenced disks. Proxmox reuses
VMIDs, so delete also refuses a guest that no longer carries this stack's ownership tags: a guest
created later under the same VMID is never deleted.

**Creation** requires an explicit `pool`. It creates stopped and untagged, waits for completion
and then writes ownership and declared user tags in a separate config update. The guest is
started unless `startAfterCreate: false` is declared. This is a
create-only power-state preference: updates and adoption never start or restart existing
guests. VM `image` imports into `disks.scsi0`, then the resize API grows it to the declared
capacity. Optional `cloudInitStorage` creates an `ide2` cloud-init drive.

VMs can opt in to `waitForCloudInit`. The provider waits up to one minute for guest-agent ping,
starts `cloud-init status --wait` once and polls exec status for up to five minutes. Exec has a
30-second request deadline. Any nonzero exit, including degraded cloud-init status, fails.
No guest command output is logged. This path is covered with constructed responses only.

**Writes** re-observe rather than trusting prior props. Partial property strings merge with
observed values. Config writes use the observed digest, then disk growth uses the resize API.
Every task is awaited and warnings are logged. Reads after writes return actual `/pending`
entries. Delete refuses guests without this stack's ownership tags and protected guests, stops
a running guest and destroys unreferenced disks.
It omits `purge`, force and lock-bypass flags; removal from backup, replication or HA
configuration is outside this lifecycle. Missing guests make delete a no-op.

**Credentials** use `makeStoredAuthProvider` with endpoint, token ID, token secret and optional CA
certificate, stored in an Alchemy profile; CI reads `PROXMOX_ENDPOINT`, `PROXMOX_TOKEN_ID`,
`PROXMOX_TOKEN_SECRET` and `PROXMOX_CA_CERT`.

## Storage downloads

`Proxmox.StorageDownload` (milestone 4) downloads a container template, ISO image or VM disk
image onto a node's storage with `POST /nodes/{node}/storage/{storage}/download-url` and waits
for the task. The wait is bounded by `timeoutMinutes` (default 30), because downloads can take
minutes. Decisions:

- **Checksums are required.** `checksum` and `checksumAlgorithm` are mandatory props, and
  `verifyCertificates` defaults to true. Proxmox verifies the file before it becomes visible.
- **Identity** is node, storage, content and filename. The `volid` attribute
  (`<storage>:<content>/<filename>`) is what a container `template` or VM `image` references.
  Filenames must already be in Proxmox's normalized form, so the volume ID cannot change.
- **Ownership.** Files cannot carry tags. A file recorded in Alchemy state is owned; any other
  existing file reads as `Unowned`, so taking it over needs `--adopt`. The content listing
  reports no checksum, so adoption cannot verify the file's content.
- **Changes.** A different node, storage, content or filename is a replacement: a new file is
  downloaded and the old one follows the removal policy. A changed `url`, checksum or
  `compression` for the same filename fails the plan with `UnsafeStorageDownloadChange`:
  Proxmox never overwrites a file, and the content cannot be compared. Certificate verification
  and the timeout affect only a download and are not compared.
- **Removal.** `defaultRemovalPolicy: "retain"`. Files carry no ownership marker, and deleting
  needs `Datastore.Allocate`, which covers every volume on the storage. With
  `RemovalPolicy.destroy()`, delete calls
  `DELETE /nodes/{node}/storage/{storage}/content/{volume}` and waits for the task. A missing
  file counts as deleted. Delete identifies the file only by its volume ID.
- **Interrupted downloads.** A timeout fails deployment while the Proxmox task keeps running.
  A file it completes later has no Alchemy state and needs `--adopt`. A replacement onto an
  existing filename fails with `StorageDownloadConflict` rather than claiming the file.

Downloads need `Datastore.AllocateTemplate` on the storage and `Sys.AccessNetwork` on the node.
A restricted token should manage a dedicated download storage that holds nothing else.

## What an API token cannot do

Measured with a pool-scoped token on Proxmox VE 9.2.11:

| Need                                                                            | Result                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Container with `nesting`                                                        | Works                                                                                        |
| VM disk imported from `local:import`, cloud-init drive, existing vendor snippet | Works                                                                                        |
| NIC on a bridge                                                                 | Needs `SDN.Use` on `/sdn/zones/localnetwork/<bridge>`                                        |
| Device passthrough (`dev[n]`, for example `/dev/net/tun`)                       | Refused: root@pam only                                                                       |
| Writing cloud-init snippets                                                     | No API; upload accepts only `iso`, `vztmpl` and `import`                                     |
| Downloading templates and images                                                | API `download-url` with checksum; needs `Datastore.AllocateTemplate` and `Sys.AccessNetwork` |

Decided: device passthrough and snippet files stay outside the provider in v1. The provider reads
both and fails the plan if they differ, so it never silently drops them.

The provider could do both later, but only with root access to the node:

- **Device passthrough.** Proxmox skips its permission check only when the authenticated user is
  exactly `root@pam` (`check_ct_modify_config_perm` in `PVE/LXC.pm`). A request with an API token
  authenticates as the token, so even a `root@pam` token is refused; the
  [`bpg/proxmox` docs](https://registry.terraform.io/providers/bpg/proxmox/latest/docs) report the
  same. The routes are a `root@pam` password login (an API ticket) or `pct set <vmid> --dev0 ...`
  over SSH as root.
- **Snippet files.** The API cannot write them;
  [Proxmox Bugzilla #2208](https://bugzilla.proxmox.com/show_bug.cgi?id=2208) tracks adding that.
  The only route is SSH or SFTP to the node's storage.

The Terraform provider `bpg/proxmox` works the same way: an optional SSH connection for snippets,
and password login for operations that API tokens cannot do. Adding either route means the provider
holds a root password or root SSH key for the node, so it needs its own design and decision.

## Testing

- Client: converter tests (invented schema fragments to Smithy), protocol tests (header, form
  encoding, envelope, errors), task polling against recorded responses. No live calls.
  `pnpm check:prose` runs with `pnpm generate` because it needs the fetched schema.
- Provider: unit tests for change classification and property strings; live tests against a node
  with a token that may change guests only inside a dedicated pool (VMIDs 950 to 999). Proxmox
  enforces that boundary.
- Storage downloads: unit tests against constructed responses, and an opt-in live phase that
  downloads one `alchemy-test-` container template to a dedicated storage and destroys it. The
  live-suite proxy allows no other storage writes; the token's storage grant is the Proxmox-side
  boundary.

## Milestones

1. Client generated from `pve-docs` 9.2.4: list guests and read configs with a token.
2. Both resources with `read` and `diff`; `alchemy plan --adopt` against an existing node's guests
   reports nothing but the ownership tags.
3. Create, update and delete in the test pool.
4. `Proxmox.StorageDownload` for templates and images; then a decision on root-only operations.
   The resource passed its live download phase. Root-only operations stay outside v1; revisit if users ask.

## Live milestone 2 validation

A GET-only `alchemy plan --adopt` against six existing guests completed successfully. Each
resource proposed only its ownership tags. No declared-versus-live differences were found.
The private stack, local state and credential launcher stay under git-ignored `.local/`.
No deploy, destroy, SSH or write API operation was used. Profile storage was not exercised;
the run used environment credentials and a custom CA with TLS verification enabled.

## Live milestone 3 validation and creation decision

The guarded suite passed create/start, default retain, unowned-plan refusal, tag-only adoption,
live changes, disk growth, pending VM memory, protection refusal, explicit destroy and
missing-guest deletion. Teardown GETs found no pool members and no volumes in the allowed
VMID range. The read-only six-guest acceptance plan still proposed only ownership tags.

The original create-with-tags design failed for both guest types with `VM.Config.Options`
on the unused VMID.

GET `/access/permissions` showed `VM.Config.Options` on the pool but not on the unused VMID.
The upstream [container permission check](https://github.com/proxmox/pve-container/blob/master/src/PVE/LXC.pm)
passes tags to [assert_tag_permissions](https://github.com/proxmox/pve-guest-common/blob/master/src/PVE/GuestHelpers.pm),
which calls `check_vm_perm` with no pool. This explains why a pool grant does not authorize
creation-time tags before the guest becomes a member. Those upstream links describe current
source, not a hash-verified copy of the installed server.

Decision: create in the pool without tags, await completion and tag the resulting pool member.
Use this path for every token; never attempt a privileged fast path. This changes the original
creation-time tagging requirement without broadening permissions. It works around
[Proxmox regression 7864](https://bugzilla.proxmox.com/show_bug.cgi?id=7864), whose status was
PATCH AVAILABLE on 2026-10-26. See the [permissions guide](../packages/alchemy-proxmox/README.md#permissions-reference).

An interruption before tagging leaves an unowned guest. Planning fails closed without
`--adopt`; the provider explains the possible interruption and Alchemy's error supplies the
adoption instruction. Recovery must match the observed guest and only adds ownership tags.
It never resumes disk growth or starts the guest during adoption. Omit unmatched capacity or
user-tag declarations during recovery, then apply those changes separately. Focused tests
cover failed tagging and tag-only recovery for both guest types.

The remaining fields used by the fixture were checked against the creation permission paths
and exercised with the pool-scoped token: cores, memory, hostname/name, description,
unprivileged container creation, disk allocation/import, cloud-init drive and agent config.
They did not require direct write grants on unused VMIDs. Root-only options remain outside
the provider's supported scope.

The legacy GET `/pools/{poolid}` also returned 403. The suite uses GET `/pools?poolid=...`,
which returned the test pool and its membership with the existing token. A loopback HTTPS
proxy checks node, VMID range and existing membership before every write from both direct
client calls and the Alchemy CLI. Teardown checks pool and storage through GET requests.

Comma-separated `delete=tags,description` removed both fields for both guest types. This is a
schema string, not an array. Boolean `0`/`1`, semicolon-separated tags and property strings
worked without a protocol change. The guest agent remained unavailable in the networkless
image, so cloud-init completion and the real array-valued `command` request remain unverified
live. Constructed-response tests cover readiness retry, execution, polling, failure and timeout.

Live reads also showed that Proxmox appends a newline to descriptions. Comparison ignores
trailing description newlines while attributes retain the API response. A real CLI destroy
exposed accidental forwarding of full resource attributes as request parameters; identity is
now projected to node and VMID at the API boundary, covered by the delete tests.

The client remains pinned to `pve-docs` 9.2.4. No schema refresh or dependency upgrade was
needed for the lifecycle. See the package READMEs for the tested node versions and limits.

## Milestone 4 status

- `Proxmox.StorageDownload` passes offline tests for the download request, task wait and
  timeout, reads with and without state, replacement, plan failures and deletion. The Alchemy
  CLI also ran against a constructed Proxmox endpoint behind the live-suite proxy: deploy, no-op
  redeploy, changed-URL plan failure, unowned refusal, `--adopt`, replacement and destroy.
  On 2026-10-26 the download phase passed against a live node: a test-prefixed container template was downloaded with SHA-512 verification and listed, a changed URL failed the plan, and destroy deleted it through `DELETE .../content/<volume>` with the URL-encoded volume ID. The test storage was empty afterwards.
- On 2026-10-26 the guarded guest live suite passed again with these changes. Without the
  download variables it reported the download phase as skipped. Follow-up GETs found an empty
  test pool and no volumes in the allowed VMID range.
- The spec fetch verifies `InRelease` with `gpgv` against the pinned trixie release key and
  follows the signed SHA256 entries to the package index. It reproduced the then committed
  `api-schema.json` byte for byte. The schema has since been removed from the repository.
- The smoke script reports failures by error tag and HTTP status only.

## Open questions

- Expand supplemental schemas for named formats beyond `ipconfig[n]` when needed.
  Unlike the inline schemas from pve-docs 9.2.4, the IP configuration supplement is written
  by hand against qemu-server 9.2.13. Its four optional string fields match the viewer's
  description and the live adoption plan; syntax validation remains server-side.
- Enable further update classes only after a dedicated live test. Unclassified updates still
  fail closed rather than guessing.

- Live confirmation of repeated-key array encoding; it needs a successful array-bearing write. Boolean
  encoding is `0`/`1`; response flags accept booleans and numeric `0`/`1`. Real validation and
  not-found responses are recorded in `packages/proxmox/README.md`; a missing guest is HTTP 500,
  not 404. The client now exposes `GuestNotFound`, matched on the status, null data and message.
- Whether the tag-only adoption change is acceptable upstream, or ownership should live in Alchemy
  state alone.
- Whether adopting a downloaded file should verify its content. Current upstream
  `download_file_from_url` (`PVE/Tools.pm`) hashes an existing file when a checksum is given:
  a match succeeds without downloading, a mismatch fails. Calling `download-url` during
  adoption could therefore check the content, but it needs the download privileges and has
  not been tested against a node.
- Whether `distilled` wants the `apidoc.js` extraction as its spec mirror, or a published OpenAPI
  conversion of it. Either way, a mirror that contains Proxmox's descriptions should be fetched
  at build time rather than committed as a submodule.
