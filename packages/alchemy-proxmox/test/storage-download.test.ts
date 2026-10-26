import { afterEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { Unowned } from "alchemy/AdoptPolicy";
import type { HttpClientRequest } from "effect/http/HttpClientRequest";
import { mockLayer } from "../../proxmox/test/helpers.ts";
import { Container } from "../src/Container.ts";
import {
  StorageDownload,
  deleteDownload,
  planDownload,
  readDownload,
  reconcileDownload,
  type StorageDownloadProps,
} from "../src/StorageDownload.ts";

const props: StorageDownloadProps = {
  node: "pve",
  storage: "local",
  content: "vztmpl",
  filename: "alpine.tar.xz",
  url: "http://download.example/alpine.tar.xz",
  checksum: "ABC123",
  checksumAlgorithm: "sha512",
};
const volid = "local:vztmpl/alpine.tar.xz";
const attributes = {
  node: "pve",
  storage: "local",
  content: "vztmpl",
  filename: "alpine.tar.xz",
  volid,
  format: "txz",
  size: 3,
} as const;
const contentPath = "/api2/json/nodes/pve/storage/local/content";
const form = (request: HttpClientRequest) =>
  new URLSearchParams(
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
  );
/** A storage holding `files`; writes are recorded and answered with a finished task. */
const storage = (files: string[]) => {
  const writes: { method: string; path: string; form: URLSearchParams }[] = [];
  const layer = mockLayer((request) => {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      writes.push({ method: request.method, path: url.pathname, form: form(request) });
      if (request.method === "POST") files.push(volid);
      return { body: { data: "UPID:pve:task" } };
    }
    if (url.pathname === contentPath) {
      expect(url.searchParams.get("content")).toBe("vztmpl");
      return { body: { data: files.map((file) => ({ volid: file, format: "txz", size: 3 })) } };
    }
    expect(url.pathname).toMatch(/\/tasks\/UPID%3Apve%3Atask\/status$/);
    return { body: { data: { status: "stopped", exitstatus: "OK" } } };
  });
  return { layer, writes };
};

afterEach(() => vi.useRealTimers());

it("downloads with the declared checksum and waits for the task", async () => {
  const { layer, writes } = storage([]);
  const result = await Effect.runPromise(
    reconcileDownload(props, undefined, undefined).pipe(Effect.provide(layer)),
  );
  expect(result).toEqual(attributes);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe("/api2/json/nodes/pve/storage/local/download-url");
  expect(Object.fromEntries(writes[0].form)).toEqual({
    content: "vztmpl",
    filename: "alpine.tar.xz",
    url: "http://download.example/alpine.tar.xz",
    checksum: "ABC123",
    "checksum-algorithm": "sha512",
    "verify-certificates": "1",
  });
});

it("reads a tracked file and reports a missing one as absent", async () => {
  const read = (files: string[]) =>
    Effect.runPromise(
      readDownload("stack/alpine", attributes, true).pipe(Effect.provide(storage(files).layer)),
    );
  const present = await read([volid, "local:vztmpl/other.tar.xz"]);
  expect(present).toEqual(attributes);
  expect(Unowned.is(present)).toBe(false);
  expect(await read([])).toBeUndefined();
});

it("reads an existing file without Alchemy state as unowned", async () => {
  const found = await Effect.runPromise(
    readDownload("stack/alpine", props, false).pipe(Effect.provide(storage([volid]).layer)),
  );
  expect(Unowned.is(found)).toBe(true);
});

it("refuses to take over an existing file without state when reconciling", async () => {
  const { layer, writes } = storage([volid]);
  const error = await Effect.runPromise(
    reconcileDownload(props, undefined, undefined).pipe(Effect.provide(layer), Effect.flip),
  );
  expect(error._tag).toBe("StorageDownloadConflict");
  expect(writes).toEqual([]);
});

it("replaces when the file identity changes", async () => {
  for (const change of [{ filename: "alpine-2.tar.xz" }, { storage: "other" }, { node: "pve2" }])
    expect(
      await Effect.runPromise(planDownload(props, { ...props, ...change }, attributes)),
    ).toEqual({ action: "replace" });
  expect(
    await Effect.runPromise(
      planDownload(props, { ...props, checksum: "abc123", timeoutMinutes: 60 }, attributes),
    ),
  ).toEqual({ action: "noop" });
});

it.each([
  [{ url: "http://download.example/alpine-new.tar.xz" }, ["url"]],
  [{ checksum: "DEF456" }, ["checksum"]],
])("fails the plan when %j changes for the same filename", async (change, changes) => {
  const error = await Effect.runPromise(
    planDownload(props, { ...props, ...change }, attributes).pipe(Effect.flip),
  );
  expect(error).toMatchObject({ _tag: "UnsafeStorageDownloadChange", changes });
  expect(error.message).toContain("new filename");
});

it("rejects filenames that Proxmox would rename", async () => {
  const error = await Effect.runPromise(
    planDownload(props, { ...props, filename: "alpine 3.tar.xz" }, attributes).pipe(Effect.flip),
  );
  expect(error._tag).toBe("StorageDownloadPlanFailed");
});

it("reports a download that outlives its timeout", async () => {
  vi.useFakeTimers();
  const layer = mockLayer((request) =>
    request.method === "POST"
      ? { body: { data: "UPID:pve:task" } }
      : request.url.includes("/tasks/")
        ? { body: { data: { status: "running" } } }
        : { body: { data: [] } },
  );
  const result = Effect.runPromise(
    reconcileDownload({ ...props, timeoutMinutes: 1 }, undefined, undefined).pipe(
      Effect.provide(layer),
      Effect.flip,
    ),
  );
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await result).toMatchObject({
    _tag: "StorageDownloadTimeout",
    message: expect.stringContaining("--adopt"),
  });
});

it("deletes the volume and waits for the task", async () => {
  const { layer, writes } = storage([volid]);
  await Effect.runPromise(deleteDownload(attributes).pipe(Effect.provide(layer)));
  expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `DELETE ${contentPath}/local%3Avztmpl%2Falpine.tar.xz`,
  ]);
});

it("treats a missing file as deleted", async () => {
  const { layer, writes } = storage([]);
  await Effect.runPromise(deleteDownload(attributes).pipe(Effect.provide(layer)));
  expect(writes).toEqual([]);
});

it("exposes the volume ID as a guest template input", () => {
  // Compile-time check only: the program is built, never run.
  const program = Effect.gen(function* () {
    const template = yield* StorageDownload("alpine", props);
    yield* Container("web", { node: "pve", vmid: 100, pool: "apps", template: template.volid });
  });
  expect(Effect.isEffect(program)).toBe(true);
});
