# Releasing

A release is a Git tag and a GitHub release with two tarballs. Nothing goes to npm, and both
packages stay `"private": true`. [DESIGN.md](DESIGN.md#packaging) explains how the tarballs are
built.

## Create a release

These steps release `0.1.0`. For another version, replace `0.1.0` everywhere. They require Node
24, pnpm 12.15.0 and the GitHub CLI.

1. Check that `version` in both `packages/*/package.json` files and the provider's peer dependency
   on `@distilled.cloud/proxmox` match the release version. If they do not, change them on `main`
   first.
2. Create a working copy on `main` and install the dependencies:

   ```sh
   jj new main
   pnpm install --frozen-lockfile
   ```

3. Run the checks:

   ```sh
   pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
   ```

4. Build and pack both packages:

   ```sh
   pnpm release:pack
   ```

   `release/` now contains `distilled.cloud-proxmox-0.1.0.tgz` and
   `alchemy.run-proxmox-0.1.0.tgz`.

5. Tag `main` and push the tag:

   ```sh
   jj tag set v0.1.0 -r main
   jj git push --remote origin --tag v0.1.0
   ```

6. Create the GitHub release with both tarballs:

   ```sh
   gh release create v0.1.0 --repo trucke/alchemy-proxmox --verify-tag --title v0.1.0 \
     --generate-notes \
     release/distilled.cloud-proxmox-0.1.0.tgz release/alchemy.run-proxmox-0.1.0.tgz
   ```

Never replace the tarballs of a published release. A project's lockfile pins each tarball's
integrity hash, so a changed file fails its next install. Release a new version instead.

## Install a release

pnpm accepts tarball URLs only in a project's own dependencies, not in dependencies of
dependencies. The provider therefore declares the client as a peer dependency, and a project
lists both tarballs. `alchemy`, `effect` and `@effect/platform-node` are peer dependencies too, so
the packages use the project's copies; the provider is tested with `alchemy` 2.0.0-beta.84:

```json
{
  "dependencies": {
    "@alchemy.run/proxmox": "https://github.com/trucke/alchemy-proxmox/releases/download/v0.1.0/alchemy.run-proxmox-0.1.0.tgz",
    "@distilled.cloud/proxmox": "https://github.com/trucke/alchemy-proxmox/releases/download/v0.1.0/distilled.cloud-proxmox-0.1.0.tgz",
    "@effect/platform-node": "4.0.5",
    "alchemy": "2.0.0-beta.84",
    "effect": "4.0.5"
  }
}
```

`pnpm install` records the integrity hash of each tarball in `pnpm-lock.yaml`. Commit the
lockfile, so that later installs fail if a tarball changes.

`@effect/platform-node` 4.0.5 installs a newer `@effect/platform-node-shared` that expects a newer
Effect, so pnpm reports an unmet peer dependency. To keep all Effect packages at 4.0.5, as this
repository does, add an override to the project's `pnpm-workspace.yaml`:

```yaml
overrides:
  "@effect/platform-node-shared": "4.0.5"
```

Then write a stack as in the [example](../README.md#example) and set up
[authentication](../packages/alchemy-proxmox/README.md#authentication).
