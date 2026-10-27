# alchemy-proxmox

Manage Proxmox VE containers, virtual machines and downloaded templates as code with
[Alchemy](https://alchemy.run).

> [!WARNING]
> Early. Nothing is published to npm, and the API can still change. Tagged releases on GitHub can
> be [installed as tarballs](docs/RELEASING.md#install-a-release).

| Package                                                      | Contents                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| [`@alchemy.run/proxmox`](packages/alchemy-proxmox/README.md) | Alchemy resources for containers, virtual machines and downloads |
| [`@distilled.cloud/proxmox`](packages/proxmox/README.md)     | Effect client for the Proxmox VE API, generated from its schema  |

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
creates container 200 in the pool `apps`, tags it as owned by this stack and starts it. The
container has no network interface: adding one needs an extra permission and has not been tested
yet (see [Limitations](#limitations)).

A stack groups resources. `"alpine"` and `"web"` are the names Alchemy uses for the resources in
the stack, not names on the node. Alchemy records what it created in the `.alchemy/` directory
next to the stack file; keep that directory, because it is how Alchemy recognizes its own
downloaded files. Each stage (`--stage`, by default `live_<your user name>`) is a separate
deployment with its own state.

## Try it

Requires Node 24, pnpm 12.15.0 and a Proxmox VE 9.2 node.

1. Clone the repository and install the dependencies:

   ```sh
   git clone https://github.com/trucke/alchemy-proxmox.git
   cd alchemy-proxmox
   pnpm install --frozen-lockfile
   ```

2. Save the example as `packages/alchemy-proxmox/alchemy.run.ts`, with your own node, pool, VMID
   and storage names. Run the remaining commands from that directory:

   ```sh
   cd packages/alchemy-proxmox
   ```

3. Create an API token. To limit it to the guests in one pool, follow
   [Configure a pool-scoped token](packages/alchemy-proxmox/README.md#configure-a-pool-scoped-token).
4. Provide the token through the
   [environment variables or an Alchemy profile](packages/alchemy-proxmox/README.md#authentication).
5. Preview and apply the changes. `plan` only reads; it lists the download and the container as
   new resources.

   ```sh
   pnpm exec alchemy plan
   pnpm exec alchemy deploy
   ```

## Safety defaults

- **Nothing is deleted by accident.** Removing a guest or file from the stack makes Alchemy forget
  it and leaves it on the node. Deleting needs an explicit `RemovalPolicy.destroy()`, and the
  provider deletes only guests that carry this stack's ownership tags.
- **No replacements.** A change that would require recreating a guest fails the plan.
- **No silent takeovers.** An existing guest or file becomes part of a stack only with
  `--adopt`, and adopting a guest only adds the ownership tags.
- **No reboots.** Changes that apply only after a reboot are written and reported as pending.

## Limitations

- Changing a guest's network address, gateway or bridge, or moving a disk to other storage, fails
  the plan. These changes are not supported yet.
- API tokens cannot configure device passthrough, so set it up outside the provider. Snippet
  files must be created outside the provider; a VM can reference an existing snippet at creation.
- Network interfaces and the cloud-init wait have not been tested against a live node.
- Only Proxmox VE 9.2 has been tested.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # offline checks
pnpm specs:fetch && pnpm generate                               # regenerate the client
```

[Develop and regenerate](packages/proxmox/README.md#develop-and-regenerate) explains the client
generation, and [docs/TESTING.md](docs/TESTING.md) the tests, including the live suite.
[docs/DESIGN.md](docs/DESIGN.md) explains the design decisions, and
[docs/RELEASING.md](docs/RELEASING.md) describes how to create and install a release.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The client is generated from Proxmox's
API schema (AGPL-3.0-or-later) but contains only its structure, no Proxmox text; see
[Proxmox schema text](docs/DESIGN.md#proxmox-schema-text).

This is an independent project, not affiliated with Proxmox Server Solutions GmbH or Alchemy.
