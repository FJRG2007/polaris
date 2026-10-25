/**
 * Every node type the engine can run: core's, then each installed app's
 * through `AppExtension.automationNodes`. Core never imports app code; an app
 * that is not installed contributes nothing, and a run that reaches one of its
 * nodes is refused with "appMissing" rather than failing.
 */

import * as core from "@polaris/core";
import type { ServerNode } from "./types";
import { HTTP_SERVER_NODES } from "./nodes/http-node";
import { codeNode } from "./nodes/code-node";
import { redeployNode } from "./nodes/deploy-node";
import { CORE_SERVER_NODES } from "./nodes/core-nodes";
import { appAutomationNodes } from "@/lib/app-extensions/registry";

const CORE = new Map<string, ServerNode>(
    [
        ...CORE_SERVER_NODES,
        ...HTTP_SERVER_NODES,
        redeployNode as ServerNode,
        codeNode as ServerNode
    ].map((node) => [node.type, node])
);

export async function serverNode(type: string): Promise<ServerNode | null> {
    const own = CORE.get(type);
    if (own) return own;
    const contributed = await appAutomationNodes().catch(() => []);
    return contributed.find((node) => node.type === type) ?? null;
}

export function coreServerNodeTypes(): string[] {
    return [...CORE.keys()];
}

/**
 * `core.graphProblems`, with every app node's config checked by its app's own
 * schema as core's are. An app that is not installed checks nothing: its node
 * is refused with "appMissing" when a run reaches it.
 */
export async function graphProblems(
    graph: core.AutomationGraph,
    options: { forPublish?: boolean } = {}
): Promise<core.GraphProblem[]> {
    const problems = core.graphProblems(graph, options);
    const apps = graph.nodes.filter((node) => !core.isCoreNodeType(node.type));
    if (apps.length === 0) return problems;
    const contributed = await appAutomationNodes().catch(() => []);
    const byType = new Map(contributed.map((node) => [node.type, node]));
    for (const node of apps) {
        const parsed = byType.get(node.type)?.config.safeParse(node.config);
        if (parsed && !parsed.success)
            problems.push({
                code: "badConfig",
                node: node.id,
                issue: parsed.error.issues[0]?.message ?? "invalid"
            });
    }
    return problems;
}
