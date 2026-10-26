import type { ProxmoxConfig } from "@distilled.cloud/proxmox/credentials";
import { getEnv, getEnvRedactedRequired, getEnvRequired } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const PROXMOX_AUTH_PROVIDER_NAME = "Proxmox";
export type ProxmoxAuthConfig = StoredAuthConfig;
export type ProxmoxResolvedCredentials = ProxmoxConfig & {
  type: "token";
  source: { type: ProxmoxAuthConfig["method"] | "env" };
};
const auth = makeStoredAuthProvider<ProxmoxResolvedCredentials>({
  provider: PROXMOX_AUTH_PROVIDER_NAME,
  fields: [
    { name: "endpoint", label: "Proxmox HTTPS endpoint" },
    { name: "tokenId", label: "Proxmox API token ID", secret: true },
    { name: "tokenSecret", label: "Proxmox API token secret", secret: true },
    { name: "caCert", label: "CA certificate PEM", optional: true },
  ],
  toResolved: (values) => ({
    type: "token",
    endpoint: storedValueText(values.endpoint) ?? "",
    tokenId: storedSecret(values.tokenId) ?? Redacted.make(""),
    tokenSecret: storedSecret(values.tokenSecret) ?? Redacted.make(""),
    caCert: storedValueText(values.caCert),
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    endpoint: getEnvRequired("PROXMOX_ENDPOINT"),
    tokenId: getEnvRedactedRequired("PROXMOX_TOKEN_ID"),
    tokenSecret: getEnvRedactedRequired("PROXMOX_TOKEN_SECRET"),
    caCert: getEnv("PROXMOX_CA_CERT"),
  }).pipe(
    Effect.map((config) => ({
      ...config,
      type: "token" as const,
      source: { type: "env" as const },
    })),
  ),
  environment: [
    { name: "PROXMOX_ENDPOINT", required: true },
    { name: "PROXMOX_TOKEN_ID", required: true, secret: true },
    { name: "PROXMOX_TOKEN_SECRET", required: true, secret: true },
    { name: "PROXMOX_CA_CERT", required: false },
  ],
});
/** Register profile storage and CI environment authentication for Proxmox. */
export const ProxmoxAuth = auth.layer;
