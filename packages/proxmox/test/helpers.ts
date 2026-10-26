import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as Response from "effect/http/HttpClientResponse";
import type { HttpClientRequest } from "effect/http/HttpClientRequest";
import { credentials } from "../src/credentials.ts";

export function mockLayer(
  reply: (request: HttpClientRequest) => { status?: number; body: unknown },
) {
  return Layer.mergeAll(
    credentials({
      endpoint: "https://example.invalid:8006",
      tokenId: Redacted.make("test@realm!reader"),
      tokenSecret: Redacted.make("test-secret"),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const result = reply(request);
        return Effect.succeed(
          Response.fromWeb(
            request,
            new globalThis.Response(JSON.stringify(result.body), {
              status: result.status ?? 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    ),
  );
}
