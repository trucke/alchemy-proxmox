# alchemy-proxmox

Manage Proxmox VE containers, virtual machines and downloaded templates as code with
[Alchemy](https://alchemy.run).

> [!WARNING]
> Early and unreleased. Nothing is published to npm yet, and the API can still change.

| Package                                                      | Contents                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [`@alchemy.run/proxmox`](packages/alchemy-proxmox/README.md) | Alchemy resources `Proxmox.Container`, `Proxmox.VirtualMachine` and `Proxmox.StorageDownload` |
| [`@distilled.cloud/proxmox`](packages/proxmox/README.md)     | Effect client for the Proxmox VE API, generated from Proxmox's API schema (678 operations)    |

## Example

This stack downloads an Alpine container template and creates a container from it:

```ts
import * as Alchemy from "alchemy";
import * as Proxmox from "@alchemy.run/proxmox";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Example",
  { providers: Proxmox.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
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
      vmid: 200,
      pool: "apps",
      template: template.volid,
      config: { hostname: "web", memory: 512 },
      disks: { rootfs: { storage: "local-lvm", sizeGiB: 4 } },
    });
    return {};
  }),
);
```

`alchemy deploy` downloads the template, and Proxmox verifies its checksum. The provider then
creates container 200 in the pool `apps`, tags it as owned by this stack and starts it.

## Try it

Requires Node 24, pnpm 12.15.0 and a Proxmox VE 9.2 node.

1. Clone the repository and install the pinned dependencies:

   ```sh
   git clone https://github.com/trucke/alchemy-proxmox.git
   cd alchemy-proxmox
   pnpm install --frozen-lockfile
   ```

2. Create an API token. For a token that can change only the guests in one pool, follow
   [Configure a pool-scoped token](packages/alchemy-proxmox/README.md#configure-a-pool-scoped-token).
3. Provide the credentials through the environment, for example from a secret manager.
   Never put the token in the stack or in command arguments.

   | Variable               | Value                                                    |
   | ---------------------- | -------------------------------------------------------- |
   | `PROXMOX_ENDPOINT`     | API address, for example `https://pve.example.com:8006`  |
   | `PROXMOX_TOKEN_ID`     | Token ID, for example `alchemy@pve!deploy`               |
   | `PROXMOX_TOKEN_SECRET` | Token secret                                             |
   | `PROXMOX_CA_CERT`      | Optional: PEM contents (not a file name) of a private CA |

   An Alchemy profile can store the credentials instead. See
   [Store the token in a profile](packages/alchemy-proxmox/README.md#store-the-token-in-a-profile).

4. Save the example as `packages/alchemy-proxmox/alchemy.run.ts`. Replace the node, pool,
   VMID and storage names with your own.
5. Preview the changes. Planning makes only read requests:

   ```sh
   cd packages/alchemy-proxmox
   pnpm exec alchemy plan
   ```

   The plan lists the download and the container as new resources.

6. Apply the changes:

   ```sh
   pnpm exec alchemy deploy
   ```

## Safety defaults

- **Retained by default.** Removing a guest or downloaded file from the stack makes Alchemy
  forget it but leaves it on the node. Deleting it requires `.pipe(RemovalPolicy.destroy())` on
  the resource, with `RemovalPolicy` imported from `alchemy/RemovalPolicy`.
- **No replacements.** A change that would require recreating a guest fails the plan instead.
- **Explicit ownership.** Guests created by a stack carry the tags `alchemy`, the stack name and
  the stage name. The provider deletes only guests with this stack's tags and refuses guests
  with `protection` set.
- **Adoption on request.** Alchemy takes over an existing guest or file only with
  `alchemy deploy --adopt`, and `alchemy plan --adopt` previews the takeover. Adopting a guest
  adds the ownership tags and changes nothing else.
- **No automatic reboots.** Changes that take effect only after a reboot, such as VM memory,
  are written and reported as pending.

[docs/DESIGN.md](docs/DESIGN.md) explains these decisions.

## Limitations

- Changing a guest's address, gateway or bridge, moving a disk and renaming a cloud-init VM
  are not supported yet. Such changes fail the plan.
- Settings that Proxmox allows only for `root@pam`, such as device passthrough and snippet
  references, are compared but never written.
- Waiting for cloud-init (`waitForCloudInit`) has not been tested against a live node.
- Only Proxmox VE 9.2 has been tested.

## Development

Run these commands from the repository root:

| Command                                                         | Purpose                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` | Offline checks; none of them need a Proxmox node or the schema                              |
| `pnpm specs:fetch`                                              | Download the pinned Proxmox API schema and verify it against Proxmox's signed package index |
| `pnpm generate`                                                 | Regenerate the client from the schema and check for Proxmox schema text                     |
| `pnpm smoke`                                                    | Read-only check against a real node                                                         |
| `pnpm test:live`                                                | Opt-in suite that creates and deletes guests in a dedicated test pool                       |

The [client README](packages/proxmox/README.md#develop-and-regenerate) describes regeneration.
The [provider README](packages/alchemy-proxmox/README.md#run-the-live-suite) describes the live
suite and the permissions it needs.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The client is generated from the API schema in Proxmox's `pve-docs` package
(AGPL-3.0-or-later). This repository keeps only the schema's structure (paths, methods,
parameter names, types and constraints) and none of Proxmox's documentation text.
`pnpm specs:fetch` downloads the schema at build time. See
[Proxmox schema text](docs/DESIGN.md#proxmox-schema-text) for the reasoning.

This is an independent project, not affiliated with Proxmox Server Solutions GmbH or Alchemy.
