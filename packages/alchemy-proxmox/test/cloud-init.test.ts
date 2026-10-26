import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { mockLayer } from "../../proxmox/test/helpers.ts";
import { waitForCloudInit } from "../src/CloudInit.ts";

afterEach(() => vi.useRealTimers());
it("waits for the agent and polls one command until completion", async () => {
  vi.useFakeTimers();
  let pings = 0;
  let executions = 0;
  let polls = 0;
  const layer = mockLayer((request) => {
    if (request.url.endsWith("/ping"))
      return ++pings === 1
        ? { status: 500, body: { data: null, message: "QEMU guest agent is not running" } }
        : { body: { data: {} } };
    if (request.url.includes("exec-status"))
      return { body: { data: ++polls === 3 ? { exited: 1, exitcode: 0 } : { exited: 0 } } };
    executions++;
    return { body: { data: { pid: 42 } } };
  });
  const result = Effect.runPromise(
    waitForCloudInit({ node: "pve", vmid: 100 }).pipe(Effect.provide(layer)),
  );
  await vi.advanceTimersByTimeAsync(7000);
  await result;
  expect({ pings, executions, polls }).toEqual({ pings: 2, executions: 1, polls: 3 });
});
it("bounds cloud-init polling", async () => {
  vi.useFakeTimers();
  let polls = 0;
  const layer = mockLayer((request) => {
    if (request.url.includes("exec-status")) {
      polls++;
      return { body: { data: { exited: false } } };
    }
    return { body: { data: request.url.endsWith("/ping") ? {} : { pid: 42 } } };
  });
  const result = Effect.runPromise(
    waitForCloudInit({ node: "pve", vmid: 100 }).pipe(Effect.provide(layer), Effect.flip),
  );
  await vi.advanceTimersByTimeAsync(300001);
  expect(await result).toMatchObject({
    _tag: "CloudInitFailed",
    message: "Cloud-init timed out in VM 100",
  });
  expect(polls).toBe(150);
});
