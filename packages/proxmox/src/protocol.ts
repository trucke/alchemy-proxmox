import * as API from "@distilled.cloud/core/api";
import { makeRestProtocol } from "@distilled.cloud/core/protocol-rest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Request from "effect/http/HttpClientRequest";
import * as Response from "effect/http/HttpClientResponse";
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

/**
 * Rebuilds an HTTP client error without the Authorization header. Effect redacts the header only
 * through its own inspect hooks, and Node's crash output bypasses them, so the request that an
 * error keeps would print the token. A response keeps the request and the raw socket as well, so
 * only its status and headers are kept.
 */
export function withoutCredentials(
  error: HttpClientError.HttpClientError,
): HttpClientError.HttpClientError {
  const { reason } = error;
  const request = Request.removeHeader(reason.request, "authorization");
  const fields = { request, cause: reason.cause, description: reason.description };
  const statusOnly = (response: Response.HttpClientResponse) =>
    Response.fromWeb(
      request,
      new globalThis.Response(null, { status: response.status, headers: response.headers }),
    );
  const rebuilt = (): HttpClientError.HttpClientErrorReason => {
    switch (reason._tag) {
      case "TransportError":
        return new HttpClientError.TransportError(fields);
      case "EncodeError":
        return new HttpClientError.EncodeError(fields);
      case "InvalidUrlError":
        return new HttpClientError.InvalidUrlError(fields);
      case "StatusCodeError":
        return new HttpClientError.StatusCodeError({
          ...fields,
          response: statusOnly(reason.response),
        });
      case "DecodeError":
        return new HttpClientError.DecodeError({
          ...fields,
          response: statusOnly(reason.response),
        });
      case "EmptyBodyError":
        return new HttpClientError.EmptyBodyError({
          ...fields,
          response: statusOnly(reason.response),
        });
    }
  };
  return new HttpClientError.HttpClientError({ reason: rebuilt() });
}

// Adapt core's JSON REST encoder, retaining its label/query binding, response
// validation, key mapping and status errors. Core's optimized `call` would bypass
// this encoder, so `call` below runs it instead.
export const ProxmoxProtocol: Layer.Layer<API.Protocol> = Layer.effect(
  API.Protocol,
  Effect.gen(function* () {
    const base = yield* API.Protocol;
    const protocol = API.Protocol.of({
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
    // Core's encode -> execute -> decode path, with the token removed from failures. Core turns
    // a failed body read into a defect, hence `catchDefect`. Like core's own `call`, this reads
    // the HttpClient from the calling fiber and erases the error channel; ProxmoxOpContext and
    // ProxmoxOpError restore both for callers.
    const call = (operation: API.PreparedOperation, input: unknown) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { inputAst, outputAst, errors, config } = operation;
        const request = yield* protocol.encode({ input, inputAst, config });
        const response = yield* client.execute(request).pipe(Effect.mapError(withoutCredentials));
        return yield* protocol.decode({ response, outputAst, errors, config });
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.die(
            HttpClientError.isHttpClientError(defect) ? withoutCredentials(defect) : defect,
          ),
        ),
      ) as Effect.Effect<unknown>;
    return API.Protocol.of({ ...protocol, call });
  }).pipe(Effect.provide(rest)),
);
