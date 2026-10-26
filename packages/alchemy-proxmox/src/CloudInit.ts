import {
  postNodesByNodeQemuByVmidAgentPing,
  postNodesByNodeQemuByVmidAgentExec,
  getNodesByNodeQemuByVmidAgentExecStatus,
} from "@distilled.cloud/proxmox/services/nodes_qemu";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class CloudInitFailed extends Data.TaggedError("CloudInitFailed")<{ message: string }> {}
class CloudInitPending extends Data.TaggedError("CloudInitPending") {}

/** Requires a running guest agent. Never logs guest command output, which may contain secrets. */
export const waitForCloudInit = Effect.fn(function* (identity: { node: string; vmid: number }) {
  yield* postNodesByNodeQemuByVmidAgentPing(identity).pipe(
    Effect.retry({
      while: (error) => error._tag === "InternalServerError",
      times: 29,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.timeoutOrElse({
      duration: "1 minute",
      orElse: () =>
        Effect.fail(
          new CloudInitFailed({ message: `Guest agent unavailable in VM ${identity.vmid}` }),
        ),
    }),
  );
  const process = yield* postNodesByNodeQemuByVmidAgentExec({
    ...identity,
    command: ["cloud-init", "status", "--wait"],
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new CloudInitFailed({ message: `Guest agent exec timed out in VM ${identity.vmid}` }),
        ),
    }),
  );
  yield* getNodesByNodeQemuByVmidAgentExecStatus({ ...identity, pid: process.pid }).pipe(
    Effect.flatMap((status) =>
      Effect.gen(function* () {
        if (!status.exited) return yield* new CloudInitPending();
        if (status.exitcode !== 0 || status.signal !== undefined)
          return yield* new CloudInitFailed({
            message: `Cloud-init failed in VM ${identity.vmid} (exit ${status.exitcode ?? "unknown"}, signal ${status.signal ?? "none"})`,
          });
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "CloudInitPending",
      times: 149,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("CloudInitPending", () =>
      Effect.fail(new CloudInitFailed({ message: `Cloud-init timed out in VM ${identity.vmid}` })),
    ),
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () =>
        Effect.fail(
          new CloudInitFailed({ message: `Cloud-init timed out in VM ${identity.vmid}` }),
        ),
    }),
  );
});
