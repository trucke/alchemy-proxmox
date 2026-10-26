import { Credentials, normalizeEndpoint } from "@distilled.cloud/proxmox/credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PROXMOX_AUTH_PROVIDER_NAME,
  type ProxmoxAuthConfig,
  type ProxmoxResolvedCredentials,
} from "./AuthProvider.ts";
export { Credentials, credentials, CredentialsFromEnv } from "@distilled.cloud/proxmox/credentials";

/** Resolve credentials lazily without retaining sensitive errors or HTTP requests. */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolve = yield* resolveProviderConfig<ProxmoxAuthConfig, ProxmoxResolvedCredentials>(
        PROXMOX_AUTH_PROVIDER_NAME,
      ).pipe(
        Effect.flatMap(({ resolve }) => resolve),
        Effect.flatMap((config) =>
          Effect.try({
            try: () => ({ ...config, endpoint: normalizeEndpoint(config.endpoint) }),
            catch: () => ConfigError.make({ message: "Invalid Proxmox HTTPS endpoint" }),
          }),
        ),
        Effect.mapError(() =>
          ConfigError.make({ message: "Unable to resolve Proxmox credentials" }),
        ),
        deferUntilFirstUse,
      );
      return yield* resolve.pipe(
        orDieCredentialsUnavailable(PROXMOX_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );
