import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { ProxmoxAuth } from "./AuthProvider.ts";
import { fromAuthProvider } from "./Credentials.ts";
import { fromCredentials } from "./Environment.ts";
import { Container, ContainerProvider } from "./Container.ts";
import { VirtualMachine, VirtualMachineProvider } from "./VirtualMachine.ts";
import { StorageDownload, StorageDownloadProvider } from "./StorageDownload.ts";
export class Providers extends Provider.ProviderCollection<Providers>()("Proxmox") {}
/** Register the guest and storage download providers and profile/environment authentication. */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Container, VirtualMachine, StorageDownload])).pipe(
    Layer.provide(
      Layer.mergeAll(ContainerProvider(), VirtualMachineProvider(), StorageDownloadProvider()),
    ),
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(ProxmoxAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
