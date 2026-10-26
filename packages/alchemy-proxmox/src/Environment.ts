import { Credentials, type ProxmoxConfig } from "@distilled.cloud/proxmox/credentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Resolve this environment inside lifecycle operations, never into resource state. */
export class ProxmoxEnvironment extends Context.Service<
  ProxmoxEnvironment,
  Effect.Effect<ProxmoxConfig>
>()("Proxmox::Environment") {
  static current = ProxmoxEnvironment.use((environment) => environment);
  readonly kind = "Environment" as const;
}
export const fromCredentials = () => Layer.effect(ProxmoxEnvironment, Credentials);
