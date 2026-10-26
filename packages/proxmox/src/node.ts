import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Layer from "effect/Layer";
import { credentials, type ProxmoxConfig } from "./credentials.ts";

/** Scoped agents trust the configured CA without disabling hostname verification. */
export const nodeLayer = (config: ProxmoxConfig) =>
  Layer.mergeAll(
    credentials(config),
    NodeHttpClient.layerNodeHttpOptions({
      ca: config.caCert || undefined,
      rejectUnauthorized: true,
    }),
  );
