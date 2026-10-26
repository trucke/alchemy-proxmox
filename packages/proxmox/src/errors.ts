export * from "@distilled.cloud/core/errors";
import {
  HTTP_STATUS_MAP,
  type DefaultErrors as CoreDefaultErrors,
} from "@distilled.cloud/core/errors";
import * as Category from "@distilled.cloud/core/category";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http/HttpClientError";

export class UnknownProxmoxError extends Schema.TaggedError<UnknownProxmoxError>()(
  "UnknownProxmoxError",
  {
    message: Schema.String,
    status: Schema.Number,
    body: Schema.Unknown,
  },
).pipe(Category.withServerError) {}
export class ProxmoxParseError extends Schema.TaggedError<ProxmoxParseError>()(
  "ProxmoxParseError",
  {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  },
).pipe(Category.withParseError) {}
export class ParameterValidationError extends Schema.TaggedError<ParameterValidationError>()(
  "ParameterValidationError",
  {
    message: Schema.String,
    errors: Schema.Record(Schema.String, Schema.String),
  },
).pipe(Category.withBadRequestError) {}
/** The guest configuration is absent, despite Proxmox returning HTTP 500. */
export class GuestNotFound extends Schema.TaggedError<GuestNotFound>()("GuestNotFound", {
  message: Schema.String,
}).pipe(Category.withNotFoundError) {}
export type DefaultErrors =
  | CoreDefaultErrors
  | UnknownProxmoxError
  | ProxmoxParseError
  | ParameterValidationError
  | GuestNotFound;

/**
 * A log-safe failure summary: tag, transport reason and HTTP status when known. HTTP client
 * errors retain the request with its Authorization header, and messages or bodies can echo
 * submitted values, so none of them are included.
 */
export function describeError(error: unknown): string {
  if (error instanceof HttpClientError) {
    const status = error.response?.status;
    return `${error._tag} (${error.reason._tag}${status === undefined ? "" : `, HTTP ${status}`})`;
  }
  if (typeof error !== "object" || error === null) return "Unknown failure";
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined;
  // Core's status classes carry no status. GatewayTimeout stands for both 408 and 504.
  const statuses =
    error instanceof UnknownProxmoxError
      ? [error.status]
      : Object.entries(HTTP_STATUS_MAP)
          .filter(([, type]) => error instanceof type)
          .map(([status]) => status);
  const name = tag ?? (error instanceof Error ? error.name : "Unknown failure");
  return statuses.length ? `${name} (HTTP ${statuses.join(" or ")})` : name;
}
