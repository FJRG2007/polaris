/**
 * "Run another automation" references between automations: the publish-time
 * check that refuses a cycle, so a chain of calls always ends, and the run-time
 * check that refuses a call back into the chain it is part of.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** Automations one check reads at most: the depth limit bounds a real chain long before this. */
const MAX_VISITS = 50;

function callTargets(graph: core.AutomationGraph): { node: string; target: string }[] {
    return graph.nodes.flatMap((node) => {
        if (node.type !== "core.run" || node.enabled === false) return [];
        const config = core.CORE_NODE_CONFIGS["core.run"].safeParse(node.config);
        return config.success ? [{ node: node.id, target: config.data.automationId }] : [];
    });
}

/**
 * The call in `graph` that leads back to `automationId` through the published
 * versions of the automations it calls, or null when every chain ends.
 */
export async function callCycle(
    automationId: string,
    graph: core.AutomationGraph,
    publishedGraph: (id: string) => Promise<core.AutomationGraph | null>
): Promise<{ node: string } | null> {
    for (const start of callTargets(graph)) {
        const seen = new Set<string>();
        const queue = [start.target];
        while (queue.length && seen.size < MAX_VISITS) {
            const id = queue.shift()!;
            if (id === automationId) return { node: start.node };
            if (seen.has(id)) continue;
            seen.add(id);
            const next = await publishedGraph(id);
            if (next) queue.push(...callTargets(next).map((call) => call.target));
        }
    }
    return null;
}

/**
 * Whether `target` is already running further up this chain of calls - the
 * chain is the line of parent runs that started this one, so its root run is
 * the chain's id. A -> B -> A stops at the call that closes the loop, with a
 * reason that says so, instead of only at the depth limit. Bounded by it.
 */
export async function callsBackIntoChain(
    run: { readonly id: string; readonly automation: { readonly id: string } },
    target: string
): Promise<boolean> {
    if (run.automation.id === target) return true;
    let at: string | null = run.id;
    for (let hop = 0; at && hop <= core.AUTOMATION_LIMITS.depth; hop++) {
        const row: { automationId: string; parentRunId: string | null } | null =
            await prisma.automationRun.findUnique({
                where: { id: at },
                select: { automationId: true, parentRunId: true }
            });
        if (!row) return false;
        if (row.automationId === target) return true;
        at = row.parentRunId;
    }
    return false;
}
