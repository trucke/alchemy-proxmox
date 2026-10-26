import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

export interface ProxmoxConfig {
  readonly endpoint: string;
  readonly tokenId: Redacted.Redacted<string>;
  readonly tokenSecret: Redacted.Redacted<string>;
  /** PEM contents, not a filename. Configure TLS on the injected HTTP client. */
  readonly caCert?: string;
}
export class Credentials extends Context.Service<Credentials, Effect.Effect<ProxmoxConfig>>()(
  "ProxmoxCredentials",
) {}
export const normalizeEndpoint = (endpoint: string) => {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Proxmox endpoint must be HTTPS without credentials, query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/api2/json")
    throw new Error("Proxmox endpoint path must be /api2/json");
  url.pathname = "/api2/json";
  return url.href;
};
export const credentials = (config: ProxmoxConfig) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({ ...config, endpoint: normalizeEndpoint(config.endpoint) }),
  );
export const configFromEnv = Config.all({
  endpoint: Config.String("PROXMOX_ENDPOINT"),
  tokenId: Config.Redacted("PROXMOX_TOKEN_ID"),
  tokenSecret: Config.Redacted("PROXMOX_TOKEN_SECRET"),
  caCert: Config.String("PROXMOX_CA_CERT").pipe(Config.withDefault("")),
}).pipe(Effect.map((config) => ({ ...config, endpoint: normalizeEndpoint(config.endpoint) })));
export const CredentialsFromEnv = Layer.succeed(Credentials, configFromEnv.pipe(Effect.orDie));
