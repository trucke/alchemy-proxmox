import * as API from "@distilled.cloud/core/api";
import { makeRestProtocol } from "@distilled.cloud/core/protocol-rest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as Request from "effect/http/HttpClientRequest";
import { Credentials, type ProxmoxConfig } from "./credentials.ts";
import {
  UnknownProxmoxError,
  GuestNotFound,
  ProxmoxParseError,
  ParameterValidationError,
  type DefaultErrors,
} from "./errors.ts";

export type ProxmoxOpError = DefaultErrors | HttpClientError.HttpClientError;
export type ProxmoxOpContext = Credentials | HttpClient.HttpClient;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const wireValue = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error("Form parameters must be scalar values or arrays of scalar values");
};
/** Repeated keys preserve array elements without guessing a comma-separated codec. */
export function formEncode(input: Record<string, unknown>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) form.append(key, wireValue(item));
  }
  return form.toString();
}
export const authHeaders = (config: ProxmoxConfig) => ({
  Authorization: `PVEAPIToken=${Redacted.value(config.tokenId)}=${Redacted.value(config.tokenSecret)}`,
  Accept: "application/json",
});
const rest = makeRestProtocol({
  credentials: Credentials,
  baseUrl: (config: ProxmoxConfig) => config.endpoint,
  headers: authHeaders,
  transformResponse: (body) => (object(body) && "data" in body ? body.data : body),
  unknownError: ({ status, message, body }) => new UnknownProxmoxError({ status, message, body }),
  parseError: ({ body, cause }) => new ProxmoxParseError({ body, cause }),
});

// Adapt core's JSON REST encoder, retaining its label/query binding, response
// validation, key mapping and status errors. Do not retain its optimized `call`,
// which would bypass this encoder.
export const ProxmoxProtocol: Layer.Layer<API.Protocol> = Layer.effect(
  API.Protocol,
  Effect.gen(function* () {
    const base = yield* API.Protocol;
    return API.Protocol.of({
      encode: (args) =>
        base.encode(args).pipe(
          Effect.map((request) => {
            // Core embeds query parameters in the URL. Convert actual booleans,
            // never string parameters that happen to contain "true" or "false".
            const url = new URL(request.url);
            if (object(args.input)) {
              for (const [key, value] of Object.entries(args.input)) {
                if (typeof value === "boolean" && url.searchParams.has(key))
                  url.searchParams.set(key, value ? "1" : "0");
              }
            }
            let encoded = Request.setUrl(request, url.href);
            if (
              request.body._tag === "Uint8Array" &&
              request.body.contentType === "application/json"
            ) {
              const body: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
              if (!object(body)) throw new Error("Expected form object");
              encoded = Request.bodyText(
                encoded,
                formEncode(body),
                "application/x-www-form-urlencoded",
              );
            }
            return encoded;
          }),
        ),
      decode: (args) =>
        Effect.gen(function* () {
          if (args.response.status === 500) {
            const body = yield* args.response.json.pipe(Effect.orElseSucceed(() => undefined));
            if (
              object(body) &&
              body.data === null &&
              typeof body.message === "string" &&
              /^Configuration file 'nodes\/[^/\r\n']+\/(?:lxc|qemu-server)\/[0-9]+\.conf' does not exist\n$/.test(
                body.message,
              )
            ) {
              // Core erases the protocol error channel; ProxmoxOpError restores it.
              return yield* Effect.fail(
                new GuestNotFound({ message: body.message }),
              ) as unknown as Effect.Effect<never>;
            }
          }
          if (args.response.status === 400) {
            const body = yield* args.response.json.pipe(Effect.orElseSucceed(() => undefined));
            if (object(body) && object(body.errors)) {
              const errors = Object.fromEntries(
                Object.entries(body.errors).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              );
              // Protocol's erased error channel is restored by ProxmoxOpError.
              return yield* Effect.fail(
                new ParameterValidationError({
                  message:
                    typeof body.message === "string"
                      ? body.message
                      : "Parameter verification failed",
                  errors,
                }),
              ) as unknown as Effect.Effect<never>;
            }
          }
          return yield* base.decode(args);
        }),
    });
  }).pipe(Effect.provide(rest)),
);
