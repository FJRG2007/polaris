/**
 * Bringing a Redis Cluster's nodes together once they are up.
 *
 * The steps are `@polaris/core`'s (`redisClusterSetupSteps`) and run through the
 * same sequencer a template's setup does - wait until ready, then run - from
 * inside the first node, which reaches the others by name on the network they
 * share. Run after every deploy: the first creates the cluster, and the rest
 * introduce each node again at the address its container came back on.
 */

import * as core from "@polaris/core";
import type { RuntimePorts } from "@polaris/deploy";
import { DatabaseOperationError, lastLine, runWithin, type InstanceContext } from "./ops";

/** How long one check or step inside the first node is given. A cluster create
 *  moves no data; it assigns slots and waits for the nodes to agree. */
const STEP_LIMIT_MS = 5 * 60_000;

/**
 * Create the cluster if it does not exist yet, and wait until it answers
 * queries with every node known. Throws with the step that failed and the last
 * line it printed, the password masked out.
 */
export async function ensureRedisCluster(
    ports: Pick<RuntimePorts, "runIn">,
    context: Pick<InstanceContext, "container" | "admin" | "cluster">,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
    const nodes = context.cluster;
    if (!nodes || nodes.length === 0) return;
    const password = context.admin.password;
    const outcomes = await core.runPrepareSteps(
        core.redisClusterSetupSteps(nodes.length / 2),
        (script) =>
            runWithin(
                ports,
                context.container,
                core.redisClusterExec(password, script, nodes),
                STEP_LIMIT_MS
            ),
        sleep
    );
    const failed = outcomes.find((outcome) => !outcome.ok);
    if (failed && !failed.ok) {
        const said = lastLine(failed.output, [password]);
        throw new DatabaseOperationError(
            `${failed.title} failed: ${[failed.reason, said].filter(Boolean).join(" ")}`
        );
    }
}
