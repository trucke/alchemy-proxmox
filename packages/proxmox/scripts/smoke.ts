import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { configFromEnv } from "../src/credentials.ts";
import { describeError } from "../src/errors.ts";
import { nodeLayer } from "../src/node.ts";
import { getClusterResources } from "../src/services/cluster.ts";
import { getNodesByNodeLxcByVmidConfig } from "../src/services/nodes_lxc.ts";
import { getNodesByNodeQemuByVmidConfig } from "../src/services/nodes_qemu.ts";

class UnexpectedGuestIdentity extends Data.TaggedError("UnexpectedGuestIdentity") {}

const program = Effect.gen(function* () {
  const guests = yield* getClusterResources({ type: "vm" });
  for (const guest of guests) {
    if (!guest.node || !guest.vmid || (guest.type !== "lxc" && guest.type !== "qemu"))
      return yield* new UnexpectedGuestIdentity();
    const input = { node: guest.node, vmid: guest.vmid };
    const config = yield* guest.type === "lxc"
      ? getNodesByNodeLxcByVmidConfig(input)
      : getNodesByNodeQemuByVmidConfig(input);
    console.log(
      JSON.stringify({
        vmid: guest.vmid,
        type: guest.type,
        name: guest.name,
        node: guest.node,
        status: guest.status,
        cores: config.cores,
        memory: config.memory,
        configKeys: Object.keys(config).length,
      }),
    );
  }
  console.log(`Read ${guests.length} guest configurations (GET only)`);
});
const exit = await Effect.runPromiseExit(
  Effect.flatMap(configFromEnv, (config) => program.pipe(Effect.provide(nodeLayer(config)))),
);
if (Exit.isFailure(exit)) {
  // Print only the summary: HTTP client failures retain requests and credentials.
  console.error(
    `Smoke failed: ${describeError(Cause.squash(exit.cause))}. Check endpoint, CA trust, token permissions and response schemas.`,
  );
  process.exitCode = 1;
}
