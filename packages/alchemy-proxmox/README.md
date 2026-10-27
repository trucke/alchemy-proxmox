# @alchemy.run/proxmox

Alchemy resources for Proxmox VE, built on the [`@distilled.cloud/proxmox`](../proxmox/README.md)
client:

- `Proxmox.Container` and `Proxmox.VirtualMachine` create, update, adopt and delete LXC
  containers and QEMU virtual machines.
- `Proxmox.StorageDownload` downloads container templates, ISO images and disk images onto a
  node's storage.

Requires `alchemy` 2.0.0-beta.84, Effect 4.0.5 and Proxmox VE 9.2. The package is not published
to npm yet. The [repository README](../../README.md#try-it) explains how to use it from source.

## Authentication

The provider authenticates with a Proxmox API token. It reads the token from environment
variables or from an Alchemy profile. When all required variables are set, they take precedence
over the profile.

| Variable               | Required | Value                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| `PROXMOX_ENDPOINT`     | Yes      | API address, for example `https://pve.example.com:8006` |
| `PROXMOX_TOKEN_ID`     | Yes      | Token ID, for example `alchemy@pve!deploy`              |
| `PROXMOX_TOKEN_SECRET` | Yes      | Token secret                                            |
| `PROXMOX_CA_CERT`      | No       | PEM contents of a private CA, not a file name           |

Certificate and hostname verification are always enabled. Use the DNS name that the node's
certificate covers, not its IP address. Never put the token in a stack or in command arguments.
Error messages and logs do not contain the token.

### Store the token in a profile

To keep the token in an Alchemy profile instead of the environment:

1. Create a profile:

   ```sh
   alchemy profile create proxmox
   ```

2. From the directory that contains your `alchemy.run.ts`, add the Proxmox credentials. Set
   `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET` first. The `env:` references read the values
   from those variables, so the token does not appear in the command:

   ```sh
   alchemy profile edit --profile proxmox --add Proxmox --method stored \
     --set endpoint=https://pve.example.com:8006 \
     --set tokenId=env:PROXMOX_TOKEN_ID \
     --set tokenSecret=env:PROXMOX_TOKEN_SECRET
   ```

   For a private CA, also pass `--set caCert=env:PROXMOX_CA_CERT`.

3. Unset the `PROXMOX_*` variables and run Alchemy with the profile:

   ```sh
   alchemy plan --profile proxmox
   ```

`alchemy profile delete proxmox` removes the profile and its stored credentials.

## Plan an existing guest

To check how a declaration matches a guest that already exists, without changing it:

1. Provide the credentials as described in [Authentication](#authentication).
2. Declare the guest with the settings you expect it to have:

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

3. Run the plan:

   ```sh
   alchemy plan --adopt --no-input
   ```

   For a matching guest, the plan shows only the ownership tags as a change. Any other
   difference fails the plan. `alchemy plan` changes nothing. `alchemy deploy --adopt` adds the
   tags.

## Guest reference

`Proxmox.Container` and `Proxmox.VirtualMachine` accept these properties:

- `node` and `vmid`: required. They cannot change after creation.
- `pool`: required for creation. The guest joins the pool when it is created and is never moved
  to another pool.
- `config`: guest settings with Proxmox API field names. Property strings such as `net0` accept
  a raw string or a partial typed object. Only declared fields and keys are compared, so values
  that Proxmox generates, such as MAC addresses, cause no changes.
- `disks`: disk keys mapped to `{ storage, sizeGiB? }`. Compared by storage and size, not by
  volume name. Container keys are `rootfs` and `mp<n>`. VM keys include `scsi<n>`, `ide<n>`,
  `sata<n>` and `virtio<n>`.
- `template` (containers) and `image` (VMs): the volume to create the guest from, for example a
  `StorageDownload`'s `volid`. Used only at creation and not compared with existing guests. A VM
  image is imported as `disks.scsi0` and then grown to its declared size.
- `sshKeys`: used only at creation and not compared.
- `startAfterCreate`: defaults to `true`. Starts a new guest after creation and disk growth. Set
  `false` to leave it stopped. Existing guests are never started or restarted.
- `cloudInitStorage` (VMs): creates a cloud-init drive as `ide2`. Do not also declare
  `config.ide2`.
- `waitForCloudInit` (VMs): after the start, waits for the guest agent and then runs
  `cloud-init status --wait`. Requires a running guest agent and `startAfterCreate`. A nonzero
  exit, including cloud-init's degraded status, fails the deployment. The command output is not
  logged.

Attributes contain `node`, `vmid`, the observed `config` and the `pending` changes that Proxmox
reports. Credentials and cloud-init passwords are excluded.

### Changes

The provider compares the declaration with the guest's current configuration, not with the
previous declaration:

| Change                                                                                                                                   | Result                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `onboot`, `startup`, `tags`, `description`, `hostname`, `name`, `swap`, `protection`, container `memory`, `firewall` on a network device | Applied in place                                           |
| Disk growth                                                                                                                              | Applied in place                                           |
| `cores`, `sockets`, `cpu`, `cpulimit`, `cpuunits`, `balloon`, VM `memory`                                                                | Written and reported as pending; the guest is not rebooted |
| `node`, `vmid`, `config.ostype`, `config.arch`, `config.unprivileged`, `config.template`, disk shrink                                    | Plan fails: the guest would have to be recreated           |
| `ip`, `ip6`, `gw`, `gw6` or `bridge` of a network device, `ipconfig<n>`, disk storage, renaming a VM that has a cloud-init drive         | Plan fails: not supported yet                              |
| `dev<n>` (device passthrough), `cicustom` (snippet references)                                                                           | Plan fails: only `root@pam` can change these               |
| Any other field                                                                                                                          | Plan fails until its behavior is implemented               |

Updates write only the declared values that differ. Inside property strings, values that
Proxmox generated are kept.

### Ownership and adoption

A guest that belongs to a stack carries three tags: `alchemy`, the stack name and the stage name,
in lowercase. The stack and stage tags count only next to `alchemy`. Stack and stage names must
be valid Proxmox tags.

Any other guest reads as Alchemy's `Unowned` and needs `--adopt`. Adoption fails if any declared
setting differs from the guest. The only change it makes is adding the missing ownership tags;
existing tags stay.

### Creation

The provider creates a guest stopped and untagged in the requested pool. A separate update then
adds the ownership tags and the declared tags. Then the disks grow to their declared size and the
guest starts.

The separate tagging step works around
[Proxmox bug 7864](https://bugzilla.proxmox.com/show_bug.cgi?id=7864): Proxmox checks tag
permissions on `/vms/<vmid>` and ignores the pool that the guest is being created in, so a
pool-scoped token cannot set tags during creation.

If creation is interrupted before the tags are set, the guest stays unowned. The next plan
refuses to take it over without `--adopt` and names the possible interruption. Before adopting,
match the declaration to the actual guest: adoption only adds the ownership tags and never
resizes or starts the guest. An imported image may not have reached its declared size yet.
Declared tags must already match. Otherwise, omit them during recovery and add them in a later
update.

### Deletion

Guests are retained by default. Removing a guest from the stack makes Alchemy forget it, and the
guest stays on the node. To delete it instead, apply `RemovalPolicy.destroy()` from
`alchemy/RemovalPolicy` to the resource with `.pipe(...)`.

Before deleting, the provider reads the guest again and refuses unless it still carries this
stack's ownership tags. Proxmox reuses VMIDs, so a different guest under the same VMID is never
deleted. The provider also refuses guests with `protection` set. It stops the guest if it is
running and deletes it with `destroy-unreferenced-disks=1`. A guest that no longer exists counts
as deleted.

The provider never uses `purge`, `skiplock` or other force options. Backup, replication and high
availability entries for the guest are not removed.

## Storage download reference

`Proxmox.StorageDownload` downloads a file onto a node's storage through
`POST /nodes/{node}/storage/{storage}/download-url` and waits for the download task.

- `node`, `storage`, `content` and `filename` identify the file. `content` is `vztmpl`
  (container template), `iso` (ISO image) or `import` (VM disk image). The storage must be file
  based and enabled for that content. `filename` may contain only letters, digits, `_`, `.` and
  `-`, because Proxmox replaces other characters and the volume ID would change.
- `url` is an HTTP or HTTPS source. It is kept in Alchemy state, so do not put credentials in it.
- `checksum` and `checksumAlgorithm` (`md5`, `sha1`, `sha224`, `sha256`, `sha384` or `sha512`)
  are required. Proxmox verifies the file before it becomes visible.
- `compression` decompresses the file after the download. Proxmox supports it only for `iso`.
- `verifyCertificates` defaults to `true`. `timeoutMinutes` limits the wait for the download task
  and defaults to 30. Neither is compared after the download.

Attributes contain the identity, `volid` (`<storage>:<content>/<filename>`), `format` and `size`.
Pass `volid` to a container's `template` or a VM's `image`.

Plans compare declarations with Alchemy state:

| Change                                                        | Plan                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `node`, `storage`, `content` or `filename`                    | Replace: download a new file; the old file follows the removal policy           |
| `url`, `checksum`, `checksumAlgorithm` or `compression` alone | Fail with `UnsafeStorageDownloadChange`; declare a new filename for new content |
| `verifyCertificates` or `timeoutMinutes` alone                | No change                                                                       |

Proxmox never overwrites an existing file, and the storage API reports no checksum, so the
content of an existing file cannot be compared with a declaration. A replacement whose new
filename already exists fails with `StorageDownloadConflict`.

Files carry no ownership marker. A file that Alchemy state does not record reads as `Unowned`, so
taking it over needs `--adopt`. Adoption cannot verify the file's content.

If the download task does not finish within `timeoutMinutes`, the deployment fails with
`StorageDownloadTimeout`. The task keeps running on the node. When it completes, the file exists
without Alchemy state, and the next plan needs `--adopt`.

Downloaded files are retained by default. With `RemovalPolicy.destroy()`, deletion removes the
volume through `DELETE /nodes/{node}/storage/{storage}/content/{volume}` and waits for the task.
A missing file counts as deleted. Deletion identifies the file only by its volume ID, so a
different file stored later under the same name is deleted too.

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

## Permissions reference

Guest privileges apply on `/vms/<vmid>`. Guests in a pool inherit them from `/pool/<pool>`.
Creation checks the requested pool.

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
| Live suite inventory and cleanup checks                | `VM.Audit`, `Sys.Audit` and `Datastore.Audit`; the suite queries the pool with `/pools?poolid=...`                                                                    |

The table lists what each operation needs. The roles in
[Configure a pool-scoped token](#configure-a-pool-scoped-token) grant more than that.

Query pools with `/pools?poolid=<pool>`, which works with inherited privileges. The older
`/pools/<pool>` endpoint requires `Pool.Audit` directly on the pool. A role assigned on a pool can
override inherited privileges, so check the effective permissions there.

Some settings need more than the table shows. Proxmox checks `Sys.Modify` on `/` for a VM's
`startup`. Settings that only `root@pam` can change, such as device passthrough, host paths and
hook scripts, are outside this reference. The provider never uses purge or lock bypass options
to work around missing privileges.

The API schema also accepts `Sys.Audit` and `Sys.Modify` on `/` for downloads. Prefer the
narrower `Sys.AccessNetwork` on `/nodes/<node>`. `Sys.AccessNetwork` lets the node fetch any URL
on the token's behalf, and no built-in role other than `Administrator` contains it, so grant it
through a custom role. `Datastore.Allocate` cannot be limited to the files a stack downloaded.
Give downloads a dedicated file-based storage that holds nothing else, and grant the download and
delete privileges on that storage only.

Sources: the API schema (`pve-docs` 9.2.4, fetched by `pnpm specs:fetch`; see
[the client README](../proxmox/README.md#develop-and-regenerate)),
[QEMU permission checks](https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu.pm)
and [container permission checks](https://github.com/proxmox/pve-container/blob/master/src/PVE/LXC.pm).
The linked source files are Proxmox's development branch and can differ from your version.

## Configure a pool-scoped token

This setup gives a token write access only to the guests in one pool. An administrator performs
these steps; the provider and the live suite never create users or change permissions.

1. Create a dedicated user in the Proxmox VE authentication realm, for example
   `alchemy-ci@pve`. Do not reuse an administrator account.
2. Create an empty dedicated pool, for example `alchemy-tests`.
3. In **Datacenter > Permissions**, assign these propagated permissions to the user:

   | Path                      | Role               | Purpose                                           |
   | ------------------------- | ------------------ | ------------------------------------------------- |
   | `/`                       | `PVEAuditor`       | Read inventory, configs, tasks, pools and storage |
   | `/pool/alchemy-tests`     | `PVEVMAdmin`       | Manage only guests in the pool                    |
   | `/storage/<disk-storage>` | `PVEDatastoreUser` | Allocate and grow disks and the cloud-init drive  |

   Template and image storage needs no write permission; `PVEAuditor` covers reading it. Do not
   assign `PVEVMAdmin` on `/` or `/vms`.

4. In **Datacenter > Permissions > API Tokens**, create a token for the user with **Privilege
   Separation** off. The token then has the user's permissions.
5. Store the token secret in a secret manager. Proxmox shows it only once.
6. Check the token's effective permissions with `GET /access/permissions?path=<path>` for `/`, the
   pool and each storage. A VMID outside the pool must show only read privileges.

With **Privilege Separation** on, keep the user permissions and assign the same roles to the
token as well. Proxmox uses the intersection of user and token permissions. This variant has not
been tested.

This setup grants no `SDN.Use`, so the token cannot add network interfaces. Downloads need two
more permissions:

| Path                          | Role                                      | Purpose                                       |
| ----------------------------- | ----------------------------------------- | --------------------------------------------- |
| `/storage/<download-storage>` | `PVEDatastoreAdmin`                       | Download files and delete volumes there       |
| `/nodes/<node>`               | Custom role with only `Sys.AccessNetwork` | Let the node fetch URLs on the token's behalf |

`PVEDatastoreAdmin` contains `Datastore.Allocate`, `Datastore.AllocateTemplate`,
`Datastore.AllocateSpace` and `Datastore.Audit`. Grant it only on the dedicated download storage,
because it allows deleting every volume there.

## Run the live suite

The live suite creates, changes and deletes real guests. Run it only with a dedicated test pool,
a pool-scoped token and an unused VMID range. It requires Node 24 and `openssl`, and it creates no
network interfaces.

1. Provide the credentials as described in [Authentication](#authentication).
2. Set the test environment variables:

   | Variable                | Value                                                    |
   | ----------------------- | -------------------------------------------------------- |
   | `PROXMOX_TEST_NODE`     | Existing node name                                       |
   | `PROXMOX_TEST_POOL`     | Dedicated, empty test pool                               |
   | `PROXMOX_TEST_MIN_VMID` | First allowed VMID; used for the container               |
   | `PROXMOX_TEST_MAX_VMID` | Last allowed VMID; must exceed the first                 |
   | `PROXMOX_TEST_STORAGE`  | Storage supporting container rootfs and VM disks         |
   | `PROXMOX_TEST_TEMPLATE` | Existing Debian container template volume                |
   | `PROXMOX_TEST_IMAGE`    | Existing Debian cloud image import volume, at most 4 GiB |

3. From the repository root, run the suite:

   ```sh
   pnpm test:live
   ```

The suite runs the Alchemy CLI against `live/stack.ts` with the first two VMIDs of the range. It
covers creation, retain, tag-only adoption, typed plan failures, live updates, pending VM memory,
disk growth, protection refusal, destroy and deleting a missing guest. Containers use 256 to
512 MiB of memory and 2 to 3 GiB of disk; VMs use 512 to 768 MiB and 4 to 5 GiB. If the test VM's
guest agent is unavailable, the suite reports the cloud-init wait as not verified instead of
passing it.

A local HTTPS proxy checks every write before it reaches the node: the node and VMID must match
the configured range, and existing guests must be members of the test pool. Creation must name
that pool. The proxy verifies the node's TLS certificate. Its temporary TLS files never contain
credentials and are removed on exit. Alchemy state stays in the ignored `.alchemy/` directory.

Teardown always runs, also after a failure, and deletes the test guests. Read requests then
confirm that the pool is empty and that no volumes from the VMID range remain on the test
storage.

After an interrupted run, run `pnpm test:live:cleanup` with the same environment. It deletes only
guests that match both the pool and the VMID range, refuses protected guests and reports
leftover volumes instead of deleting them.

### Download phase

The suite tests downloads only when all three download variables are set. Without them, it
reports the phase as skipped. Setting only some of them fails the suite.

| Variable                        | Value                                                                    |
| ------------------------------- | ------------------------------------------------------------------------ |
| `PROXMOX_TEST_DOWNLOAD_STORAGE` | Dedicated file-based storage enabled for `vztmpl`, holding no other data |
| `PROXMOX_TEST_DOWNLOAD_URL`     | HTTP or HTTPS URL of a small container template                          |
| `PROXMOX_TEST_DOWNLOAD_SHA512`  | SHA-512 checksum of that file                                            |

Proxmox's 3.2 MB Alpine template works:
`http://download.proxmox.com/images/system/alpine-3.22-default_20250617_amd64.tar.xz` with the
SHA-512 checksum
`1900ccb1b092b5563c0430ff9d9ede63c23bf2fa4a872b8816d2b03d711c76c1d2ea2241796ebaa58292caee75a01e325b7a9c86f63e36d9f9425b45e0115469`
from `aplinfo-pve-9.dat`.

The phase runs first, in a separate stack. It stores the file as
`alchemy-test-<last URL path segment>`, checks that the storage lists it, checks that a changed
URL fails the plan with `UnsafeStorageDownloadChange` and deletes the file. The proxy allows only
two storage writes: downloading an `alchemy-test-` container template to the download storage and
deleting such a template there. Teardown and `pnpm test:live:cleanup` delete leftover
`alchemy-test-` templates, and the final checks require that none remain.

## Compatibility and limits

- Tested with Proxmox VE 9.2: `pve-manager` 9.2.21, `qemu-server` 9.2.11, `pve-container` 6.1.14
  and `libpve-guest-common-perl` 6.0.5. The client is generated from `pve-docs` 9.2.4.
- Not tested against a live node yet: `waitForCloudInit`, guests with network interfaces, `iso`
  and `import` downloads, `compression`, a download that reaches its timeout, token privilege
  separation and interactive profile prompts.
- Proxmox tasks that finish with warnings count as successful. The provider logs the number of
  warnings.
- Named property-string formats other than `ipconfig<n>` stay plain strings. See
  [the client's property-string codecs](../proxmox/README.md#property-string-codecs).
