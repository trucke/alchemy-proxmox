# @alchemy.run/proxmox

Alchemy provider for Proxmox VE containers, virtual machines and storage downloads. It is not
published to npm yet.
Requires `alchemy@2.0.0-beta.84` and Effect 4.0.5. The guest resources implement planning,
creation, in-place updates and deletion. `Proxmox.StorageDownload` downloads templates and
images onto a node's storage. Guests and downloaded files are retained by default.

## Resource reference

Both resources require explicit `node` and `vmid`. Both retain guests by default.
Creation also requires `pool`. Pool membership is create-only and is never moved on update.
Use `RemovalPolicy.destroy()` from `alchemy/RemovalPolicy` to opt in to deletion.

- `config`: API field names. Inline property strings accept a raw string or partial typed
  object. Only declared fields and nested keys participate in comparison. Generated MACs,
  digests and other omitted config values do not cause changes.
- `disks`: disk keys mapped to `{ storage, sizeGiB? }`. Compares storage and capacity without
  guessing generated volume names. Container keys are `rootfs` and `mp<number>`; VM keys
  include `scsi<number>`, `ide<number>`, `sata<number>` and `virtio<number>`.
- `template` (containers), `image` (VMs) and `sshKeys`: create-only declarations. Not compared
  against existing guests. VM image imports use `disks.scsi0` and grow through the resize API.
- `startAfterCreate`: defaults to `true`. Creation is stopped, then starts after disk growth.
  Set `false` to leave a new guest stopped. Existing guests are never started or restarted.
- `cloudInitStorage` (VMs): creates an `ide2` cloud-init drive. Do not also declare `config.ide2`.
- `waitForCloudInit` (VMs): opt in to guest-agent readiness checks followed by
  `cloud-init status --wait`. Requires a running guest agent and `startAfterCreate`.
  Polling is bounded. A nonzero exit, including cloud-init's degraded status, fails deployment.
  Guest command output is not logged. This path has not been tested live.
- Attributes contain `node`, `vmid`, observed `config` and actual `pending` changes. Credentials
  and VM cloud-init passwords are excluded.

Live changes include hostname, description, tags, startup, onboot and network firewall flags.
VM memory, cores and CPU changes require a reboot; plans report that classification but never
reboot. Disk growth is live. Disk shrink, identity and OS-type changes fail rather than replace.
Address, gateway, bridge, storage moves and cloud-init VM renames fail as unsupported.
Device passthrough and snippet references are compared when declared but never written.
Other changes fail closed until their behavior is implemented.

An absent guest returns `undefined`. A guest owned by this stack carries the tags `alchemy`, the
stack name and the stage name (lowercase). Any other guest returns Alchemy's `Unowned`, requiring
`--adopt`. Stack and stage tags count only next to `alchemy`. Adoption fails if any declared
setting differs: the only permitted adoption delta is adding the missing ownership tags, and
existing user tags are preserved. Stack and stage names must be valid Proxmox tags.

## Storage download reference

`Proxmox.StorageDownload` downloads a file onto a node's storage through
`POST /nodes/{node}/storage/{storage}/download-url` and waits for the download task.

- `node`, `storage`, `content` and `filename` identify the file. `content` is `vztmpl`
  (container template), `iso` (ISO image) or `import` (VM disk image). The storage must be
  file based and enabled for that content. `filename` may contain only letters, digits, `_`, `.`
  and `-`, because Proxmox replaces other characters and the volume ID would change.
- `url` is an HTTP or HTTPS source. It is kept in Alchemy state, so do not embed credentials.
- `checksum` and `checksumAlgorithm` (`md5`, `sha1`, `sha224`, `sha256`, `sha384` or `sha512`)
  are required. Proxmox verifies the downloaded file before it becomes visible.
- `compression` decompresses after downloading. Proxmox supports it for `iso` only.
- `verifyCertificates` defaults to `true`. `timeoutMinutes` bounds the wait for the download
  task and defaults to 30. Neither is compared after the download.
- Attributes contain the identity, `volid` (`<storage>:<content>/<filename>`), `format` and
  `size`. Pass `volid` to a container's `template` or a VM's `image`.

Plans compare declarations with Alchemy state:

| Change                                                        | Plan                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `node`, `storage`, `content` or `filename`                    | Replace: download a new file; the old file follows the removal policy           |
| `url`, `checksum`, `checksumAlgorithm` or `compression` alone | Fail with `UnsafeStorageDownloadChange`; declare a new filename for new content |
| `verifyCertificates` or `timeoutMinutes` alone                | No change                                                                       |

Proxmox never overwrites an existing file, and the storage API reports no checksum, so the
content of an existing file cannot be compared with a declaration.

Files carry no ownership marker. A file that Alchemy state does not record reads as
`Unowned`, so taking it over needs `--adopt`. Adoption cannot verify the file's content.
A replacement whose new filename already exists fails with `StorageDownloadConflict`.

If the download task does not finish within `timeoutMinutes`, deployment fails with
`StorageDownloadTimeout`. The Proxmox task keeps running. When it completes, the file exists
without Alchemy state, and the next plan needs `--adopt`.

Downloaded files are retained by default (`defaultRemovalPolicy: "retain"`). With
`RemovalPolicy.destroy()`, delete removes the volume through
`DELETE /nodes/{node}/storage/{storage}/content/{volume}` and waits for the task. A missing
file counts as deleted. Delete identifies the file only by its volume ID: a different file
stored later under the same name is deleted too.

### Download a container template

Pass this effect to `Alchemy.Stack` as in [Plan an existing guest](#plan-an-existing-guest):

```ts
const program = Effect.gen(function* () {
  const template = yield* Proxmox.StorageDownload("alpine", {
    node: "pve",
    storage: "local",
    content: "vztmpl",
    filename: "alpine-3.22-default_20250617_amd64.tar.xz",
    url: "http://download.proxmox.com/images/system/alpine-3.22-default_20250617_amd64.tar.xz",
    checksum:
      "1900ccb1b092b5563c0430ff9d9ede63c23bf2fa4a872b8816d2b03d711c76c1d2ea2241796ebaa58292caee75a01e325b7a9c86f63e36d9f9425b45e0115469",
    checksumAlgorithm: "sha512",
  });
  yield* Proxmox.Container("web", {
    node: "pve",
    vmid: 100,
    pool: "apps",
    template: template.volid,
    disks: { rootfs: { storage: "local-lvm", sizeGiB: 4 } },
  });
  return {};
});
```

Proxmox publishes template checksums in `http://download.proxmox.com/images/aplinfo-pve-9.dat`,
with a detached signature in `aplinfo-pve-9.dat.asc`.

## Plan an existing guest

1. Supply `PROXMOX_ENDPOINT`, `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET` through the
   environment. Never place tokens in the stack or command arguments.
2. For a private CA, set `PROXMOX_CA_CERT` to its PEM contents, not a filename.
   Certificate and hostname verification remain enabled.
3. Declare the guest:

   ```ts
   import * as Alchemy from "alchemy";
   import * as Proxmox from "@alchemy.run/proxmox";
   import * as Effect from "effect/Effect";

   export default Alchemy.Stack(
     "Example",
     { providers: Proxmox.providers(), state: Alchemy.localState() },
     Effect.gen(function* () {
       yield* Proxmox.Container("web", {
         node: "pve",
         vmid: 100,
         config: { hostname: "web", net0: { name: "eth0", ip: "dhcp" } },
         disks: { rootfs: { storage: "local-lvm", sizeGiB: 8 } },
       });
       return {};
     }),
   );
   ```

4. Run `alchemy plan --adopt --no-input`.

   A matching guest produces a tag-only delta followed by Alchemy's adoption summary.
   No guest changes or ownership claims are persisted by this command.

## Authentication reference

`ProxmoxAuth` registers a `makeStoredAuthProvider` implementation for Alchemy profiles.
Stored fields are endpoint, redacted token ID, redacted token secret and optional CA PEM.
`Credentials.fromAuthProvider()` defers resolution until first use. A complete environment
configuration takes precedence according to Alchemy's auth resolver. CI uses the environment.
Failures are sanitized rather than retaining HTTP request objects or credential values.

The environment path and CA trust were exercised against a live node. On 2026-10-26 the stored
profile path passed end to end against the same node:

1. `alchemy profile create` and `alchemy profile edit --add Proxmox --method stored`, with the
   token fields set through `env:` references so the values never appeared in arguments.
2. `alchemy plan --adopt --profile <name>` with no `PROXMOX_*` variables set. The plan resolved
   credentials from the profile and showed only the ownership tags.
3. `alchemy profile delete --yes` removed the profile and its credentials file.

Neither the token ID nor the secret appeared in Alchemy's logs under `~/.alchemy/logs`.
Interactive prompts were not exercised.

## Write lifecycle reference

Reconciliation observes the API rather than trusting prior props. Config updates merge only
changed declared leaves, preserving generated values in property strings. Reboot-required
changes are written to configuration and reported from `/pending`; no restart is performed.
Adoption writes only missing ownership tags.

Deletion re-observes the guest and refuses it unless it still carries this stack's ownership
tags; Proxmox reuses VMIDs, so a different guest under the same VMID is never deleted. It then
refuses `protection`, stops the guest if needed and deletes with
`destroy-unreferenced-disks=1`. Each task is awaited. Missing guests count as already deleted.
The provider does not use `purge`, `skiplock` or force-delete options. Backup, replication and
HA references are not purged. Alchemy skips the delete handler for retained resources.

## Run the live suite

The suite changes real guests. Use a dedicated test pool with a pool-scoped token and an unused
VMID range. Follow the permissions recipe below. Node 24 and `openssl` are required.
No network interfaces are created.

1. Inject `PROXMOX_ENDPOINT`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` and optional
   `PROXMOX_CA_CERT` through the environment. The CA value is PEM content.
2. Set the test environment variables:

   | Variable                | Required value                                           |
   | ----------------------- | -------------------------------------------------------- |
   | `PROXMOX_TEST_NODE`     | Existing node name                                       |
   | `PROXMOX_TEST_POOL`     | Dedicated, empty test pool                               |
   | `PROXMOX_TEST_MIN_VMID` | First allowed VMID; used for the container               |
   | `PROXMOX_TEST_MAX_VMID` | Last allowed VMID; must exceed the first                 |
   | `PROXMOX_TEST_STORAGE`  | Storage supporting container rootfs and VM disks         |
   | `PROXMOX_TEST_TEMPLATE` | Existing Debian container template volume                |
   | `PROXMOX_TEST_IMAGE`    | Existing Debian cloud image import volume, at most 4 GiB |

3. Run `pnpm test:live` from the repository root.

The suite invokes real Alchemy CLI commands against `live/stack.ts`. It tests creation,
retain, tag-only adoption, typed plan failures, live updates, pending VM memory, disk growth,
protection refusal, destroy and missing-guest deletion. It uses the first two VMIDs in the
range. Containers use 256-512 MiB and 2-3 GiB; VMs use 512-768 MiB and 4-5 GiB.
The fixture enables the VM guest agent and attempts the cloud-init wait. Agent unavailability
is reported as an explicit live-validation gap, not as successful cloud-init completion.

A loopback HTTPS proxy validates the node and VMID range before every write. Existing guests
must also be members of the test pool; creation must include that pool. The proxy verifies the
upstream TLS certificate. Temporary local TLS material is removed on exit. Credentials are
never written to those files. Alchemy state remains in ignored `.alchemy/`.

Teardown runs in `finally`, then GET checks require an empty pool and no volumes belonging to
the allowed range on test storage. After an interrupted run, use `pnpm test:live:cleanup` with
the same environment. Cleanup deletes only guests that match both the pool and range. It
refuses protected guests and reports orphan volumes rather than deleting storage objects
without a pool member to establish ownership.

### Download phase

The suite downloads a container template only when all three download variables are set.
Without them it prints that the phase was skipped. Setting only some of them fails the suite.

| Variable                        | Required value                                                           |
| ------------------------------- | ------------------------------------------------------------------------ |
| `PROXMOX_TEST_DOWNLOAD_STORAGE` | Dedicated file-based storage enabled for `vztmpl`, holding no other data |
| `PROXMOX_TEST_DOWNLOAD_URL`     | HTTP or HTTPS URL of a small container template                          |
| `PROXMOX_TEST_DOWNLOAD_SHA512`  | SHA-512 checksum of that file                                            |

Proxmox's Alpine template is a suitable 3.2 MB test file:
`http://download.proxmox.com/images/system/alpine-3.22-default_20250617_amd64.tar.xz` with
SHA-512 `1900ccb1b092b5563c0430ff9d9ede63c23bf2fa4a872b8816d2b03d711c76c1d2ea2241796ebaa58292caee75a01e325b7a9c86f63e36d9f9425b45e0115469`
from `aplinfo-pve-9.dat`.

The phase runs before the guest tests, in a separate stack. It stores the file as
`alchemy-test-<last URL path segment>`, checks that the storage lists it, checks that a changed
URL fails the plan with `UnsafeStorageDownloadChange` and destroys the file. The proxy allows
only two storage writes: `download-url` for an `alchemy-test-` container template on the
download storage, and deleting such a template there. Teardown and `pnpm test:live:cleanup`
delete leftover `alchemy-test-` templates on the download storage, and the final GET checks
require that none remain.

## Permissions reference

Guest privileges below apply on `/vms/<vmid>`, inherited from `/pool/<pool>` for members.
Creation uses the explicit pool for allocation and config checks. The tested setup grants
read access cluster-wide but guest-write access only through the test pool.

| Operation                                              | Privileges and scope                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read guest config, status and pending settings         | `VM.Audit` on the guest                                                                                                                                               |
| Plan, including `--adopt`                              | Same as read; planning writes nothing                                                                                                                                 |
| Create                                                 | `VM.Allocate` on the pool, plus config privileges for declared fields; `Datastore.AllocateSpace` on destination storage; `Datastore.Audit` on template/import storage |
| Update hostname, name, description, tags or protection | `VM.Config.Options` on the guest; cluster tag restrictions may require additional authority for registered tags                                                       |
| Update cores or memory                                 | `VM.Config.CPU` or `VM.Config.Memory` respectively                                                                                                                    |
| Configure VM hardware, disks, CD-ROM or cloud-init     | Corresponding `VM.Config.HWType`, `VM.Config.Disk`, `VM.Config.CDROM` or `VM.Config.Cloudinit`; storage allocation also needs `Datastore.AllocateSpace`               |
| Resize                                                 | `VM.Config.Disk` on the guest and `Datastore.AllocateSpace` on its storage                                                                                            |
| Start or stop                                          | `VM.PowerMgmt` on the guest                                                                                                                                           |
| Delete                                                 | `VM.Allocate` on the guest; this provider also reads with `VM.Audit` and stops with `VM.PowerMgmt`; protection must be cleared explicitly                             |
| Guest-agent cloud-init wait                            | `VM.GuestAgent.Unrestricted` for exec and exec-status; ping accepts this or `VM.GuestAgent.Audit`                                                                     |
| Network interfaces                                     | `VM.Config.Network` plus `SDN.Use` on `/sdn/zones/<zone>/<bridge>`; ordinary local bridges use zone `localnetwork`                                                    |
| Download a template or image (`StorageDownload`)       | `Datastore.AllocateTemplate` on `/storage/<storage>` plus `Sys.AccessNetwork` on `/nodes/<node>`; reads need `Datastore.Audit` on the storage                         |
| Delete a downloaded file (`RemovalPolicy.destroy()`)   | `Datastore.Allocate` on `/storage/<storage>`; this allows deleting any volume on that storage                                                                         |
| Test inventory and cleanup verification                | `VM.Audit`, `Sys.Audit` and `Datastore.Audit`; the suite queries the specific pool with `/pools?poolid=...`                                                           |

The legacy `/pools/<pool>` endpoint requires `Pool.Audit` directly on that pool and returned
403 with the tested ACLs. `/pools?poolid=...` returned the pool and visible members without
adding that privilege. A pool-specific role can override inherited privileges, so inspect the
effective permissions rather than assuming every root read privilege remains present there.

These are operation-specific requirements, not a claim that the tested roles are minimal.
The pinned API schema also permits the legacy download authorization using `Sys.Audit` and
`Sys.Modify` on `/`; prefer the narrower node-level `Sys.AccessNetwork` grant. Root-only
passthrough, host paths and hooks are outside this recipe. Some host-affecting options require
additional privileges: current upstream VM code checks `Sys.Modify` on `/` for `startup`.
Such options were not exercised by the live suite. The provider never supplies purge or lock
bypass flags to work around missing privileges.

`Sys.AccessNetwork` lets the node fetch any URL on the token's behalf. No built-in role other
than `Administrator` contains it, so grant it through a custom role. Give downloads a dedicated
file-based storage that holds nothing else, and grant the download and delete privileges on
that storage only: `Datastore.Allocate` cannot be limited to the files a stack downloaded.

References: the pinned API schema (`pve-docs` 9.2.4, fetched by `pnpm specs:fetch`; see
[the client README](../proxmox/README.md#develop-and-regenerate)),
[QEMU permission checks](https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu.pm)
and [container permission checks](https://github.com/proxmox/pve-container/blob/master/src/PVE/LXC.pm).
Upstream master may contain checks newer than the tested node.

## Configure a pool-scoped token

An administrator performs these setup steps. The suite does not create users, change ACLs or
expand token permissions. The role assignments below match the user ACLs and effective token
permissions observed during the live suite; they are broader than a hand-built minimal role.

1. Create a dedicated enabled user in the Proxmox VE authentication realm, for example
   `alchemy-ci@pve`. Do not reuse an administrator account.
2. Create an empty dedicated pool, for example `alchemy-tests`.
3. Assign these propagated ACLs to that user in **Datacenter > Permissions**:

   | Path                      | Role               | Purpose                                               |
   | ------------------------- | ------------------ | ----------------------------------------------------- |
   | `/`                       | `PVEAuditor`       | Read inventory, configs, tasks, pools and storage     |
   | `/pool/alchemy-tests`     | `PVEVMAdmin`       | Manage only guests in the test pool                   |
   | `/storage/<test-storage>` | `PVEDatastoreUser` | Allocate and grow test disks and the cloud-init drive |

   Existing template and import-image storage needs no write grant for this suite. Its
   `Datastore.Audit` access comes from `PVEAuditor`. Do not put `PVEVMAdmin` on `/` or `/vms`.

4. Create an API token for that user under **Datacenter > Permissions > API Tokens**.
   With **Privilege Separation off**, the token inherits the user's permissions. This
   reproduces the tested effective grants: the inspected ACLs contained user grants and no
   token-specific grants. Reading the token's own metadata returned 403, so the separation
   flag itself was not directly verified.
5. Store the token's one-time secret in a secret manager. Inject it through the environment;
   never put it in a stack, command argument or committed file.
6. Check the effective token grants with GET `/access/permissions?path=...` for `/`, the pool
   and each storage path. An unused VMID must have only read permissions. Then run the live
   suite with the matching pool, storage and an unused VMID range.

For **Privilege Separation on**, retain the user ACLs above and assign the same scoped roles
to the token as well. Proxmox uses the intersection of user and token permissions; token ACLs
alone cannot grant privileges the user lacks. This variant is documented but was not separately
exercised live.

**Network interfaces are not covered by this tested recipe.** It deliberately has no
`SDN.Use` grant and the fixture declares no NICs.

**Downloads need two additional ACLs** for the download phase. This part of the recipe passed
the live download phase on 2026-10-26:

| Path                          | Role                                      | Purpose                                          |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `/storage/<download-storage>` | `PVEDatastoreAdmin`                       | Download templates and delete volumes there      |
| `/nodes/<node>`               | Custom role with only `Sys.AccessNetwork` | Let the node fetch the URL on the token's behalf |

`PVEDatastoreAdmin` contains `Datastore.Allocate`, `Datastore.AllocateTemplate`,
`Datastore.AllocateSpace` and `Datastore.Audit`. Grant it only on the dedicated download
storage: it allows deleting every volume there.

### Why tagging is a separate step

The provider always creates stopped and untagged in the requested pool, awaits creation and
then sets ownership and declared user tags in a separate config update. There is no privileged
token fast path. Proxmox's `assert_tag_permissions` in `PVE/GuestHelpers.pm`
(`libpve-guest-common-perl`) checks `/vms/<vmid>` without considering the creation pool.

This is the known [Proxmox regression 7864](https://bugzilla.proxmox.com/show_bug.cgi?id=7864):
a `VM.Config.Options` grant on a pool stopped authorizing tags at VM creation.
As of 2026-10-26 its status is **PATCH AVAILABLE**, with patches attached since 2026-07-30
but not merged in `pve-guest-common` master. Creation could set tags directly once that fix
ships; this provider currently uses the separate step for every token.

If creation is interrupted before tagging, the guest remains unowned. The next plan refuses
to take it over without `--adopt` and explains the possible interruption. Match the declaration
to the observed guest before adopting: adoption only adds missing ownership tags, never
resizes or starts it. An imported image may not yet have reached its requested capacity.
Any declared user tags must already match, or be omitted during recovery and added in a later
update. The provider does not silently claim an untagged guest merely because its VMID matches.

## Coverage and limits

The milestone 3 node reported `pve-manager` 9.2.21, `qemu-server` 9.2.11, `pve-container`
6.1.14 and `libpve-guest-common-perl` 6.0.5. The client stays pinned to `pve-docs` 9.2.4;
no schema change was needed. The suite's networkless container tasks returned warnings,
which the provider surfaced rather than treating them as failures.

Offline tests cover property-string parsing, tag handling, ownership checks and change classes.
A live GET-only adoption plan covered six existing guests and proposed only ownership tags.
The guarded live suite passed creation/start, default retain, unowned-plan refusal, tag-only
adoption, live changes, pending VM memory, disk growth, protection refusal, destroy and missing
delete. The explicit cleanup command also passed. Follow-up GETs found an empty pool and no
test-range storage volumes. Cloud-init completion was not verified live: the networkless
image's guest agent was unavailable. Repeated-key array encoding therefore remains offline-only;
comma-separated multi-value config deletion was verified for both guest types. IP configuration uses a supplemental upstream schema
and accepts structured objects for any `ipconfig<number>` key. Other named formats without
inline schemas remain string-typed. See [the client codecs](../proxmox/README.md#property-string-codecs)
and [the design](../../docs/DESIGN.md).

On 2026-10-26 the download phase passed against a live node: a test-prefixed container template was downloaded with SHA-512 verification and listed, a changed URL failed the plan, and destroy deleted it through `DELETE .../content/<volume>` with the URL-encoded volume ID. The test storage was empty afterwards. `iso` and `import` content, `compression` and a real timeout were not exercised live.
Offline tests cover the download
request, task wait and timeout, reads with and without Alchemy state, replacement, plan
failures, deletion and missing-file deletion. The Alchemy CLI was also run locally against a
constructed Proxmox endpoint behind the live-suite proxy: deploy, no-op redeploy, changed-URL
plan failure, unowned refusal, `--adopt`, replacement and destroy behaved as described above.
