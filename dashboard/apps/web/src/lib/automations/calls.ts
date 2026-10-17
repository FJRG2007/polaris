/**
 * "Run another automation" references between automations: the publish-time
 * check that refuses a cycle, so a chain of calls always ends.
 */

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
