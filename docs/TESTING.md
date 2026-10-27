# Testing

`pnpm test` runs the offline tests. They use invented schema fragments and constructed API
responses, so they need neither a Proxmox node nor the fetched schema. `pnpm typecheck` also
checks all generated code.

The live suite runs against a real node. It is opt-in and never part of `pnpm test`.

## Run the live suite

The suite creates, changes and deletes real guests. Run it only with a dedicated, empty pool, a
token that can write only in that pool (see
[Configure a pool-scoped token](../packages/alchemy-proxmox/README.md#configure-a-pool-scoped-token))
and a VMID range that nothing else uses. It requires Node 24 and `openssl`.

1. Set the [credential variables](../packages/alchemy-proxmox/README.md#authentication).
2. Set the test variables:

   | Variable                | Value                                                                 |
   | ----------------------- | --------------------------------------------------------------------- |
   | `PROXMOX_TEST_NODE`     | Node name                                                             |
   | `PROXMOX_TEST_POOL`     | Dedicated, empty pool                                                 |
   | `PROXMOX_TEST_MIN_VMID` | First VMID the suite may use                                          |
   | `PROXMOX_TEST_MAX_VMID` | Last VMID the suite may use                                           |
   | `PROXMOX_TEST_STORAGE`  | Storage for container and VM disks                                    |
   | `PROXMOX_TEST_TEMPLATE` | Existing Debian container template volume                             |
   | `PROXMOX_TEST_IMAGE`    | Existing Debian cloud image import volume, virtual size at most 4 GiB |

3. From the repository root, run:

   ```sh
   pnpm test:live
   ```

The suite creates one container and one VM with the first two VMIDs of the range and no network
interfaces. It runs the real Alchemy CLI through creation, retain, adoption, plan failures, live
changes, pending changes, disk growth, protection and deletion. Teardown runs even after a
failure. Read requests then confirm that the pool is empty and that no disks from the VMID range
remain on the test storage.

A local HTTPS proxy sits between the suite and the node and checks every write. Guest writes must
match the configured node and VMID range. A new guest must be created in the test pool, and an
existing guest must already be in it. Storage writes are limited to the download phase described
below. The proxy verifies the node's certificate and never stores credentials.

After an interrupted run, run `pnpm test:live:cleanup` with the same variables. It deletes only
guests that are both in the pool and in the VMID range, and it reports leftover disks instead of
deleting them. With the download variables set, teardown and cleanup also delete every
`alchemy-test-*` container template on the download storage, including leftovers from earlier
runs.

## Download phase

To also test `Proxmox.StorageDownload`, set all three of these variables. Without them, the suite
skips the phase.

| Variable                        | Value                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `PROXMOX_TEST_DOWNLOAD_STORAGE` | File storage for container templates that holds nothing else |
| `PROXMOX_TEST_DOWNLOAD_URL`     | URL of a small container template                            |
| `PROXMOX_TEST_DOWNLOAD_SHA512`  | SHA-512 checksum of that file                                |

The 3.2 MB Alpine template from the [example](../README.md#example) works. The phase stores the
file as `alchemy-test-<name>`, checks that a changed URL fails the plan and deletes the file. The
proxy allows no other storage writes. Downloads need two more permissions on top of the
pool-scoped token: see the end of
[Configure a pool-scoped token](../packages/alchemy-proxmox/README.md#configure-a-pool-scoped-token).
