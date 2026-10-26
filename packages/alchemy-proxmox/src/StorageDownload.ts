import { describeError } from "@distilled.cloud/proxmox/errors";
import { nodeLayer } from "@distilled.cloud/proxmox/node";
import {
  deleteNodesByNodeStorageByStorageContentByVolume,
  getNodesByNodeStorageByStorageContent,
  postNodesByNodeStorageByStorageDownloadUrl,
  type PostNodesByNodeStorageByStorageDownloadUrlRequestChecksumAlgorithm,
  type PostNodesByNodeStorageByStorageDownloadUrlRequestContent,
} from "@distilled.cloud/proxmox/services/nodes_storage";
import { waitForTask } from "@distilled.cloud/proxmox/tasks";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ProxmoxEnvironment } from "./Environment.ts";

/** `vztmpl` for container templates, `iso` for ISO images, `import` for VM disk images. */
export type DownloadContent = PostNodesByNodeStorageByStorageDownloadUrlRequestContent;
export type ChecksumAlgorithm = PostNodesByNodeStorageByStorageDownloadUrlRequestChecksumAlgorithm;

export interface StorageDownloadProps {
  /** Node that downloads the file. Changing it downloads a new file. */
  node: string;
  /** File-based storage enabled for `content`. Changing it downloads a new file. */
  storage: string;
  /** Kind of file. Changing it downloads a new file. */
  content: DownloadContent;
  /**
   * File name on the storage: letters, digits, `_`, `.` and `-` only, so that Proxmox keeps it
   * unchanged. Changing it downloads a new file. Use a new name for new content.
   */
  filename: string;
  /** HTTP or HTTPS source. Kept in Alchemy state, so do not embed credentials. */
  url: string;
  /** Expected checksum of the downloaded file, before any decompression. */
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm;
  /** Decompress after downloading. Proxmox supports this for `iso` only. */
  compression?: string;
  /** Verify the source's TLS certificate. Defaults to true. */
  verifyCertificates?: boolean;
  /** How long to wait for the download task, in minutes. Defaults to 30. */
  timeoutMinutes?: number;
}
export interface StorageDownloadAttributes {
  node: string;
  storage: string;
  content: DownloadContent;
  filename: string;
  /** `<storage>:<content>/<filename>`, usable as a container `template` or VM `image`. */
  volid: string;
  /** File format reported by the storage. */
  format: string;
  /** Size in bytes reported by the storage. */
  size?: number;
}
type FileIdentity = Pick<StorageDownloadAttributes, "node" | "storage" | "content" | "filename">;
type Volume = FileIdentity & { volid: string };

export class StorageDownloadPlanFailed extends Data.TaggedError("StorageDownloadPlanFailed")<{
  message: string;
}> {}
export class UnsafeStorageDownloadChange extends Data.TaggedError("UnsafeStorageDownloadChange")<{
  message: string;
  changes: string[];
}> {}
export class StorageDownloadReadFailed extends Data.TaggedError("StorageDownloadReadFailed")<{
  message: string;
}> {}
export class StorageDownloadConflict extends Data.TaggedError("StorageDownloadConflict")<{
  message: string;
}> {}
export class StorageDownloadTimeout extends Data.TaggedError("StorageDownloadTimeout")<{
  message: string;
}> {}
export class StorageDownloadNotResolved extends Data.TaggedError("StorageDownloadNotResolved")<{
  message: string;
}> {}

/** Proxmox replaces other characters, which would change the volume ID. */
const SAFE_FILENAME = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_TIMEOUT_MINUTES = 30;

const identify = (file: FileIdentity) =>
  SAFE_FILENAME.test(file.filename)
    ? Effect.succeed<Volume>({
        node: file.node,
        storage: file.storage,
        content: file.content,
        filename: file.filename,
        volid: `${file.storage}:${file.content}/${file.filename}`,
      })
    : Effect.fail(
        new StorageDownloadPlanFailed({
          message: `Proxmox would rename "${file.filename}"; use only letters, digits, "_", "." and "-"`,
        }),
      );

/** Looks the file up by volume ID in the storage's content list. */
const find = Effect.fn(function* (file: Volume) {
  const volumes = yield* getNodesByNodeStorageByStorageContent({
    node: file.node,
    storage: file.storage,
    content: file.content,
  });
  const volume = volumes.find((item) => item.volid === file.volid);
  return volume && { ...file, format: volume.format, size: volume.size };
});

/**
 * Proxmox never overwrites an existing file and cannot report its checksum, so the source of a
 * downloaded file is fixed. New content needs a new filename.
 */
const rejectContentChanges = (
  olds: StorageDownloadProps,
  news: StorageDownloadProps,
  volid: string,
) => {
  const changes = (["url", "checksum", "checksumAlgorithm", "compression"] as const).filter(
    (key) =>
      key === "checksum"
        ? olds.checksum.toLowerCase() !== news.checksum.toLowerCase()
        : olds[key] !== news[key],
  );
  return changes.length
    ? Effect.fail(
        new UnsafeStorageDownloadChange({
          message: `Proxmox ${volid}: ${changes.join(", ")} changed for an existing file. Proxmox never overwrites a file and cannot report its checksum. Declare a new filename to download the new content.`,
          changes,
        }),
      )
    : Effect.void;
};

/**
 * Files carry no ownership marker. A file is owned only when Alchemy state already records it;
 * any other existing file reads as unowned and needs `--adopt`.
 */
export const readDownload = Effect.fn(function* (
  fqn: string,
  file: FileIdentity,
  tracked: boolean,
) {
  const identity = yield* identify(file);
  const found = yield* find(identity).pipe(
    Effect.mapError(
      (error) =>
        new StorageDownloadReadFailed({
          message: `Proxmox storage read failed (${describeError(error)})`,
        }),
    ),
  );
  if (!found || tracked) return found;
  yield* Effect.logWarning(
    `Proxmox ${fqn}: ${found.volid} exists without Alchemy state. A download may have been interrupted, or another tool created it. Rerun with --adopt to take it over; adoption cannot verify the file's content because the storage API reports no checksum.`,
  );
  return Unowned(found);
});

export const planDownload = Effect.fn(function* (
  olds: StorageDownloadProps,
  news: StorageDownloadProps,
  output: StorageDownloadAttributes,
) {
  const declared = yield* identify(news);
  if (declared.node !== output.node || declared.volid !== output.volid)
    return { action: "replace" } as const;
  yield* rejectContentChanges(olds, news, output.volid);
  // Certificate verification and the timeout only affect a download, so they never update.
  return { action: "noop" } as const;
});

export const reconcileDownload = Effect.fn(function* (
  news: StorageDownloadProps,
  olds: StorageDownloadProps | undefined,
  output: StorageDownloadAttributes | undefined,
) {
  const declared = yield* identify(news);
  // Reached when planning could not resolve the declaration and therefore planned no replacement.
  if (output && (output.node !== declared.node || output.volid !== declared.volid))
    return yield* new StorageDownloadPlanFailed({
      message: `Proxmox ${output.volid} cannot become ${declared.volid} in place; plan again to replace it`,
    });
  if (olds) yield* rejectContentChanges(olds, news, declared.volid);
  const minutes = news.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0)
    return yield* new StorageDownloadPlanFailed({
      message: "timeoutMinutes must be a positive number",
    });
  const existing = yield* find(declared);
  if (existing) {
    if (output) return existing;
    // Planning gates existing files behind --adopt. A replacement or a concurrent writer can
    // still reach this point, and the file's content cannot be compared with the declaration.
    return yield* new StorageDownloadConflict({
      message: `Proxmox ${declared.volid} already exists without Alchemy state, and its content cannot be verified. Remove it or declare a new filename.`,
    });
  }
  const upid = yield* postNodesByNodeStorageByStorageDownloadUrl({
    node: declared.node,
    storage: declared.storage,
    content: declared.content,
    filename: declared.filename,
    url: news.url,
    checksum: news.checksum,
    "checksum-algorithm": news.checksumAlgorithm,
    compression: news.compression,
    "verify-certificates": news.verifyCertificates ?? true,
  });
  const task = yield* waitForTask(declared.node, upid, {
    timeout: Duration.minutes(minutes),
  }).pipe(
    Effect.catchTag("TaskTimeout", () =>
      Effect.fail(
        new StorageDownloadTimeout({
          message: `Proxmox download of ${declared.volid} did not finish within ${minutes} minutes. Task ${upid} may still complete; the file then exists without Alchemy state and taking it over needs --adopt.`,
        }),
      ),
    ),
  );
  if (task.warnings)
    yield* Effect.logWarning(`Proxmox download completed with ${task.warnings} warnings`);
  const downloaded = yield* find(declared);
  if (!downloaded)
    return yield* new StorageDownloadNotResolved({
      message: `Proxmox reported a finished download, but ${declared.volid} is not listed`,
    });
  return downloaded;
});

/** Alchemy calls delete only for RemovalPolicy.destroy; retain skips the provider entirely. */
export const deleteDownload = Effect.fn(function* (output: StorageDownloadAttributes) {
  // Alchemy passes full attributes. Project identity before crossing the API boundary.
  const existing = yield* find({
    node: output.node,
    storage: output.storage,
    content: output.content,
    filename: output.filename,
    volid: output.volid,
  });
  if (!existing) return;
  const upid = yield* deleteNodesByNodeStorageByStorageContentByVolume({
    node: existing.node,
    storage: existing.storage,
    volume: existing.volid,
  });
  yield* waitForTask(existing.node, upid);
});

export type StorageDownload = Resource<
  "Proxmox.StorageDownload",
  StorageDownloadProps,
  StorageDownloadAttributes,
  never,
  import("./Providers.ts").Providers
>;
/**
 * Download a container template, ISO image or VM disk image onto a node's storage, retaining
 * the file by default.
 *
 * ### Download a container template
 * **Example:** Checksum-verified template used by a container
 * ```typescript
 * const template = yield* StorageDownload("alpine", {
 *   node: "pve", storage: "local", content: "vztmpl",
 *   filename: "alpine-3.22-default_20250617_amd64.tar.xz",
 *   url: "http://download.proxmox.com/images/system/alpine-3.22-default_20250617_amd64.tar.xz",
 *   checksum: "1900ccb1...", checksumAlgorithm: "sha512",
 * });
 * yield* Container("web", { node: "pve", vmid: 100, pool: "apps", template: template.volid });
 * ```
 * @resource
 */
export const StorageDownload = Resource<StorageDownload>("Proxmox.StorageDownload", {
  defaultRemovalPolicy: "retain",
});
export const StorageDownloadProvider = () =>
  Provider.succeed(StorageDownload, {
    stables: ["node", "storage", "content", "filename", "volid"],
    read: Effect.fn(function* ({ fqn, olds, output }) {
      const environment = yield* ProxmoxEnvironment.current;
      return yield* readDownload(fqn, output ?? olds, output !== undefined).pipe(
        Effect.provide(nodeLayer(environment)),
      );
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news) || !output) return;
      return yield* planDownload(olds, news, output);
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const environment = yield* ProxmoxEnvironment.current;
      return yield* reconcileDownload(news, olds, output).pipe(
        Effect.provide(nodeLayer(environment)),
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      const environment = yield* ProxmoxEnvironment.current;
      yield* deleteDownload(output).pipe(Effect.provide(nodeLayer(environment)));
    }),
  });
