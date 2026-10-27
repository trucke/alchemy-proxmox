# @alchemy.run/proxmox

Alchemy resources for Proxmox VE, built on the [`@distilled.cloud/proxmox`](../proxmox/README.md)
client:

- `Proxmox.Container` and `Proxmox.VirtualMachine` manage LXC containers and QEMU virtual
  machines.
- `Proxmox.StorageDownload` downloads container templates, ISO images and disk images onto a
  node's storage.

Requires `alchemy` 2.0.0-beta.84, Effect 4.0.5 and Proxmox VE 9.2. The package is not on npm yet;
see [Try it](../../README.md#try-it) for using it from source.

## Authentication

The provider uses a Proxmox API token from environment variables or from an Alchemy profile.
When all required variables are set, they take precedence over the profile.

| Variable               | Required | Value                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| `PROXMOX_ENDPOINT`     | Yes      | API address, for example `https://pve.example.com:8006` |
| `PROXMOX_TOKEN_ID`     | Yes      | Token ID, for example `alchemy@pve!deploy`              |
| `PROXMOX_TOKEN_SECRET` | Yes      | Token secret                                            |
| `PROXMOX_CA_CERT`      | No       | PEM contents of a private CA, not a file name           |

Never put the token in a stack or in command arguments.

TLS verification is always on, so use the DNS name that the node's certificate covers. By
default, Proxmox signs that certificate with its own cluster CA. Copy
`/etc/pve/pve-root-ca.pem` from the node over a connection you trust, then pass its contents:

```sh
export PROXMOX_CA_CERT="$(< pve-root-ca.pem)"
```

To store the token in a profile instead, set `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET`, then
run this from the directory that contains your `alchemy.run.ts`:

```sh
pnpm exec alchemy profile create proxmox
pnpm exec alchemy profile edit --profile proxmox --add Proxmox --method stored \
  --set endpoint=https://pve.example.com:8006 \
  --set tokenId=env:PROXMOX_TOKEN_ID \
  --set tokenSecret=env:PROXMOX_TOKEN_SECRET
```

The `env:` references read the values from the variables, so the token never appears in the
command. For a private CA, add `--set caCert=env:PROXMOX_CA_CERT`. Afterwards, unset the
variables and pass `--profile proxmox` to `pnpm exec alchemy plan` and `pnpm exec alchemy deploy`.

## Guests

`Proxmox.Container` and `Proxmox.VirtualMachine` take these properties:

- `node` and `vmid` (required) identify the guest. They cannot change later.
- `pool` is required for creation. The guest is never moved to another pool.
- `config` holds guest settings with Proxmox API field names. Property strings such as `net0`
  accept a raw string or a partial object. Only declared fields are compared, so values that
  Proxmox generates, such as MAC addresses, cause no changes.
- `disks` maps disk keys such as `rootfs` (containers) or `scsi0` (VMs) to a storage and a size
  in GiB. Creating a disk needs `sizeGiB`, except for an imported VM image. Without `sizeGiB`, the
  size of an existing disk is left alone.
- `template` (required for containers) and `image` (VMs) name the volume to create the guest
  from, for example a `StorageDownload`'s `volid`. A VM image is imported as `disks.scsi0` and
  grown to its declared size.
- `sshKeys` sets the initial SSH keys.
- `startAfterCreate` (default `true`) starts a new guest once it is set up. Existing guests are
  never started or restarted.
- `cloudInitStorage` (VMs) adds a cloud-init drive as `ide2`, so do not declare `config.ide2`
  as well.
- `waitForCloudInit` (VMs) waits until cloud-init finishes inside a new guest. It needs a running
  QEMU guest agent, installed in the image and enabled with `config.agent`, and it cannot be
  combined with `startAfterCreate: false`. A failed or degraded cloud-init run fails the
  deployment.

`template`, `image`, `sshKeys`, `startAfterCreate`, `cloudInitStorage` and `waitForCloudInit`
apply only at creation. Adding or changing them later has no effect.

Attributes contain `node`, `vmid`, the observed `config` and the changes that Proxmox reports as
pending. Credentials and cloud-init passwords are left out.

A VM created from a cloud image:

```ts
yield *
  Proxmox.VirtualMachine("app", {
    node: "pve",
    vmid: 201,
    pool: "apps",
    image: "local:import/debian-13-genericcloud-amd64.qcow2",
    cloudInitStorage: "local-lvm",
    sshKeys: ["ssh-ed25519 AAAA... you@example.com"],
    config: {
      name: "app",
      agent: { enabled: true },
      memory: { current: 1024 },
      cores: 2,
      scsihw: "virtio-scsi-single",
      boot: "order=scsi0",
    },
    disks: { scsi0: { storage: "local-lvm", sizeGiB: 16 } },
  });
```

### Changing an existing guest

At creation, every declared setting is sent to Proxmox. For an existing guest, the provider
compares the declaration with the guest's current configuration and handles differences like
this:

| Setting                                                                                  | Result                          |
| ---------------------------------------------------------------------------------------- | ------------------------------- |
| `onboot`, `startup`, `description`, `hostname`, `name`, `swap`, `protection`             | Changed in place                |
| `tags`                                                                                   | Added in place                  |
| Container `memory`, `firewall` on a network device, larger disk size                     | Changed in place                |
| `cores`, `sockets`, `cpu`, `cpulimit`, `cpuunits`, `balloon`, VM `memory`                | Written; applies after a reboot |
| `node`, `vmid`, `ostype`, `arch`, `unprivileged`, the `template` flag, smaller disk size | Plan fails: needs a new guest   |
| Network `ip`, `gw`, `ip6`, `gw6` or `bridge`, `ipconfig<n>`, disk storage                | Plan fails: not supported yet   |
| `name` of a VM with a cloud-init drive                                                   | Plan fails: not supported yet   |
| `dev<n>` (device passthrough)                                                            | Plan fails: only `root@pam`     |
| `cicustom` (snippet reference)                                                           | Plan fails: not supported yet   |
| Any other setting                                                                        | Plan fails: not supported yet   |

The provider never reboots a guest. Settings that apply after a reboot show up in the `pending`
attribute until the guest restarts. Declared tags are added to the guest's existing tags, so
removing a tag from `config.tags` does not remove it from the guest.

### Ownership, adoption and deletion

A guest that belongs to a stack carries three tags: `alchemy`, the stack name and the stage name.
Any other guest needs `--adopt` before a stack takes it over. Adoption fails if the guest differs
from the declaration in anything but the ownership tags, and it changes nothing except adding
those tags.

Guests are retained by default: removing one from the stack makes Alchemy forget it and leaves it
on the node. To delete it instead, pipe the resource through `RemovalPolicy.destroy()` from
`alchemy/RemovalPolicy`. Deletion refuses guests that no longer carry this stack's tags (Proxmox
reuses VMIDs) and guests with `protection` set. It stops the guest and deletes it together with
its unreferenced disks. It never uses `purge` or force options.

### Interrupted creation

The provider creates a guest untagged and adds the tags in a second step, because a pool-scoped
token cannot set tags during creation
([Proxmox bug 7864](https://bugzilla.proxmox.com/show_bug.cgi?id=7864)). If a deployment stops
between these steps, the guest exists without ownership tags, and the next plan asks for
`--adopt`. Before adopting, make the declaration match the guest as it is: adoption only adds the
tags and does not resize or start the guest.

## Storage downloads

`Proxmox.StorageDownload` asks the node to download a file to one of its storages and waits until
Proxmox has verified the checksum. The [repository README](../../README.md#example) shows an
example. The storage must be file based and allow the content type: `local` works, but block
storage such as `local-lvm` does not.

- `node`, `storage`, `content` and `filename` identify the file. `content` is `vztmpl`
  (container template), `iso` or `import` (VM disk image). `filename` may contain only letters,
  digits, `_`, `.` and `-`.
- `url` is the HTTP or HTTPS source. It is stored in Alchemy state, so it must not contain
  credentials.
- `checksum` and `checksumAlgorithm` (`md5`, `sha1`, `sha224`, `sha256`, `sha384` or `sha512`)
  are required.
- `compression` decompresses an `iso` after the download. `verifyCertificates` defaults to
  `true`. `timeoutMinutes` (default 30) limits the wait.
- The `volid` attribute (`<storage>:<content>/<filename>`) goes into a container's `template` or a
  VM's `image`.

Changing `node`, `storage`, `content` or `filename` downloads a new file; the old one follows the
removal policy. Changing `url`, `checksum`, `checksumAlgorithm` or `compression` alone fails the
plan, because Proxmox never overwrites a file: declare a new `filename` for new content.

Files are retained by default and carry no ownership marker. An existing file that Alchemy state
does not know needs `--adopt`, and adoption cannot check its content. Deleting a file removes
whatever is stored under its volume ID. If a download times out, the task keeps running on the
node, and the next plan needs `--adopt` for the finished file.

## Permissions

These privileges are needed in addition to reading (`VM.Audit`, `Datastore.Audit`). Guest
privileges apply on `/vms/<vmid>` and are inherited from `/pool/<pool>` for guests in a pool.

| Operation                | Privileges                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Create                   | `VM.Allocate` on the pool, `VM.Config.*`, `Datastore.AllocateSpace` on the disk storage |
| Change settings          | The matching `VM.Config.*` privilege, for example `VM.Config.Options`                   |
| Set a VM's `startup`     | Also `Sys.Modify` on `/`                                                                |
| Grow a disk              | `VM.Config.Disk`, `Datastore.AllocateSpace` on the storage                              |
| Start and stop           | `VM.PowerMgmt`                                                                          |
| Delete                   | `VM.Allocate`, `VM.PowerMgmt`                                                           |
| Wait for cloud-init      | `VM.GuestAgent.Unrestricted`                                                            |
| Add a network interface  | `VM.Config.Network`, `SDN.Use` on `/sdn/zones/<zone>/<bridge>`                          |
| Download a file          | `Datastore.AllocateTemplate` on the storage, `Sys.AccessNetwork` on the node            |
| Delete a downloaded file | `Datastore.Allocate` on the storage (allows deleting any file there)                    |

`Sys.AccessNetwork` lets the node fetch any URL for the token. Only `Administrator` contains it,
so grant it through a custom role. Because `Datastore.Allocate` covers every file on a storage,
give downloads their own storage that holds nothing else.

### Configure a pool-scoped token

This setup gives a token write access only to the guests in one pool. Use a dedicated user, not
an administrator account.

1. Create a user, for example `alchemy@pve`, and an empty pool, for example `apps`.
2. In **Datacenter > Permissions**, assign these roles to the user:

   | Path                      | Role               | Purpose                            |
   | ------------------------- | ------------------ | ---------------------------------- |
   | `/`                       | `PVEAuditor`       | Read guests, tasks, pools, storage |
   | `/pool/apps`              | `PVEVMAdmin`       | Manage the guests in the pool      |
   | `/storage/<disk-storage>` | `PVEDatastoreUser` | Allocate and grow disks            |

3. Create an API token for the user with **Privilege Separation** off, so it has the user's
   permissions. Store the secret in a secret manager; Proxmox shows it only once.
4. Check the result with `GET /access/permissions?path=<path>`. A VMID outside the pool must show
   only read privileges.

This token cannot set a VM's `startup` or add network interfaces. Granting `Sys.Modify` on `/`
or `SDN.Use` widens its reach beyond the pool, so decide that separately. For downloads, also
assign `PVEDatastoreAdmin` on a dedicated download storage and a custom role with only
`Sys.AccessNetwork` on `/nodes/<node>`.

## Limits

- Tested with Proxmox VE 9.2 (`pve-manager` 9.2.21). The client is generated from `pve-docs`
  9.2.4.
- Not tested against a live node yet: `waitForCloudInit`, guests with network interfaces, `iso`
  and `import` downloads, `compression`, download timeouts and tokens with privilege separation.
- Proxmox tasks that finish with warnings count as successful; the provider logs the warnings.

[docs/DESIGN.md](../../docs/DESIGN.md) explains the decisions behind this behavior, and
[docs/TESTING.md](../../docs/TESTING.md) describes the tests.
