/**
 * Every node type the engine can run: core's, then each installed app's
 * through `AppExtension.automationNodes`. Core never imports app code; an app
 * that is not installed contributes nothing, and a run that reaches one of its
 * nodes is refused with "appMissing" rather than failing.
 */

import type { ServerNode } from "./types";
import { HTTP_SERVER_NODES } from "./nodes/http-node";
import { CORE_SERVER_NODES } from "./nodes/core-nodes";
import { appAutomationNodes } from "@/lib/app-extensions/registry";

const CORE = new Map<string, ServerNode>([...CORE_SERVER_NODES, ...HTTP_SERVER_NODES].map((node) => [node.type, node]));

export async function serverNode(type: string): Promise<ServerNode | null> {
    const own = CORE.get(type);
    if (own) return own;
    const contributed = await appAutomationNodes().catch(() => []);
    return contributed.find((node) => node.type === type) ?? null;
}

export function coreServerNodeTypes(): string[] {
    return [...CORE.keys()];
}
