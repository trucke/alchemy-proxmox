import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ResponseValidation } from "@distilled.cloud/core";
import { formEncode } from "../src/protocol.ts";
import { getClusterResources } from "../src/services/cluster.ts";
import {
  getNodesByNodeLxcByVmidConfig,
  putNodesByNodeLxcByVmidConfig,
} from "../src/services/nodes_lxc.ts";
import { mockLayer } from "./helpers.ts";

describe("Proxmox protocol", () => {
  it("authenticates and unwraps data", async () => {
    const result = await Effect.runPromise(
      getClusterResources({ type: "vm" }).pipe(
        Effect.provide(
          mockLayer((request) => {
            expect(
              Redacted.isRedacted(request.headers.authorization)
                ? Redacted.value(request.headers.authorization)
                : request.headers.authorization,
            ).toBe("PVEAPIToken=test@realm!reader=test-secret");
            expect(request.url).toBe(
              "https://example.invalid:8006/api2/json/cluster/resources?type=vm",
            );
            return { body: { data: [] } };
          }),
        ),
      ),
    );
    expect(result).toEqual([]);
  });
  it("encodes booleans, reserved characters and repeated array parameters", () => {
    expect(
      formEncode({
        enabled: true,
        disabled: false,
        text: "a=b & c",
        list: ["a", "b"],
        omitted: undefined,
      }),
    ).toBe("enabled=1&disabled=0&text=a%3Db+%26+c&list=a&list=b");
  });
  it("sends indexed families as form fields, not literal [n] keys", async () => {
    await Effect.runPromise(
      putNodesByNodeLxcByVmidConfig({
        node: "test",
        vmid: 100,
        onboot: true,
        net0: "name=eth0,ip=dhcp",
      }).pipe(
        Effect.provide(
          mockLayer((request) => {
            expect(request.method).toBe("PUT");
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag === "Uint8Array") {
              expect(request.body.contentType).toBe("application/x-www-form-urlencoded");
              const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
              expect(form.get("onboot")).toBe("1");
              expect(form.get("net0")).toBe("name=eth0,ip=dhcp");
              expect(form.has("node")).toBe(false);
            }
            return { body: { data: null } };
          }),
        ),
      ),
    );
  });
  it("encodes query booleans as 0/1", async () => {
    await Effect.runPromise(
      getNodesByNodeLxcByVmidConfig({ node: "test", vmid: 100, current: true }).pipe(
        Effect.provide(
          mockLayer((request) => {
            expect(new URL(request.url).searchParams.get("current")).toBe("1");
            return { body: { data: {} } };
          }),
        ),
      ),
    );
  });
  it.each([
    [403, { message: "Permission check failed (/vms/100, VM.Audit)\n", data: null }, "Forbidden"],
    [
      400,
      {
        message: "Parameter verification failed.\n",
        errors: { type: "value is not in the enumeration" },
        data: null,
      },
      "ParameterValidationError",
    ],
    [404, { message: "Not found", data: null }, "NotFound"],
    [
      500,
      { data: null, message: "Configuration file 'nodes/example/lxc/999.conf' does not exist\n" },
      "GuestNotFound",
    ],
    [
      500,
      {
        data: null,
        message: "Configuration file 'nodes/example/qemu-server/999.conf' does not exist\n",
      },
      "GuestNotFound",
    ],
    [
      500,
      { data: null, message: "hostname lookup 'example' failed - not found" },
      "InternalServerError",
    ],
    [
      500,
      {
        data: null,
        message: "Configuration file 'nodes/example/storage/999.conf' does not exist\n",
      },
      "InternalServerError",
    ],
    [418, { message: "Unexpected failure", data: null }, "UnknownProxmoxError"],
  ])("maps HTTP %i", async (status, body, tag) => {
    const result = await Effect.runPromise(
      getClusterResources({}).pipe(
        Effect.flip,
        Effect.provide(mockLayer(() => ({ status, body }))),
      ),
    );
    expect(result._tag).toBe(tag);
    if (result._tag === "ParameterValidationError")
      expect(result.errors).toEqual({ type: "value is not in the enumeration" });
  });
  it("validates indexed config fields and numeric boolean flags", async () => {
    const config = { digest: "test", net0: "name=eth0,ip=dhcp", onboot: 1 };
    const result = await Effect.runPromise(
      getNodesByNodeLxcByVmidConfig({ node: "test", vmid: 100 }).pipe(
        Effect.provide(ResponseValidation.strict),
        Effect.provide(mockLayer(() => ({ body: { data: config } }))),
      ),
    );
    expect(result).toEqual(config);
  });
  it("uses core response validation and exposes a typed parse error", async () => {
    const result = await Effect.runPromise(
      getClusterResources({}).pipe(
        Effect.provide(ResponseValidation.strict),
        Effect.flip,
        Effect.provide(mockLayer(() => ({ body: { data: "invalid" } }))),
      ),
    );
    expect(result._tag).toBe("ProxmoxParseError");
  });
});
