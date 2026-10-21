/**
 * What every MCP tool call spends and leaves behind, whoever made it.
 *
 * The MCP endpoint and the Stream Deck both run tools as a credential: each
 * call is held to that credential's budgets before it runs, and a change that
 * went through is written to its person's activity naming the credential. One
 * module so a second way of calling a tool cannot skip either.
 *
 * Server-only.
 */

import { recordAudit } from "@/lib/audit-service";
import type { McpCaller, McpTool } from "./protocol";
import { rateLimit } from "@/lib/rate-limit-service";
import { DEPLOY_TOOLS } from "@/lib/mcp/tools/deploy";
import { throttleDeployKey } from "@/lib/deploy/api/http";

/** How many tool calls one credential may make a minute, and how many of them
 *  may change something. Generous for an assistant working a task, and well
 *  short of what a runaway loop would make. */
const CALLS_PER_MINUTE = 120;
const CHANGES_PER_MINUTE = 30;

/** How a call reached the tool, as the audit trail and the log name it. */
export type McpVia = "oauth" | "api-key" | "agent-session" | "streamdeck";

export function viaOf(caller: McpCaller): McpVia {
    return caller.grantId ? "oauth" : caller.keyId ? "api-key" : "agent-session";
}

/**
 * Spend a tool call against the credential's budgets: every call, and every
 * change, and for the deploy tools the Deploy API's own budgets keyed the same
 * way a REST call with this credential would be. Answers the seconds to wait
 * for a call over budget, or null for one that may run.
 */
export async function spendToolBudget(
    tool: Pick<McpTool<never>, "name" | "readOnly">,
    caller: McpCaller
): Promise<number | null> {
    const credential =
        caller.keyId ??
        caller.grantId ??
        (caller.sessionId ? `session:${caller.sessionId}` : `user:${caller.userId}`);
    for (const [bucket, limit] of [
        [`mcp-call:${credential}`, CALLS_PER_MINUTE],
        ...(tool.readOnly ? [] : [[`mcp-change:${credential}`, CHANGES_PER_MINUTE] as const])
    ] as const) {
        const throttle = await rateLimit(bucket, limit, 60_000);
        if (!throttle.ok) return Math.max(1, Math.ceil(throttle.retryAfterMs / 1000));
    }

    const deployKey = caller.keyId ?? caller.grantId;
    if (!deployKey || !DEPLOY_TOOLS.some((candidate) => candidate.name === tool.name)) return null;
    return throttleDeployKey(deployKey, !tool.readOnly);
}

/**
 * Write a tool call that changed something to the person's activity, saying
 * which credential made it. Only for calls that went through, since a refusal
 * changed nothing; a read is never written.
 */
export async function auditToolChange(
    tool: Pick<McpTool<never>, "name" | "readOnly">,
    caller: McpCaller,
    via: McpVia
): Promise<void> {
    if (tool.readOnly) return;
    await recordAudit({
        actorId: caller.userId,
        action: "mcp.tool.called",
        targetType: "mcpTool",
        metadata: {
            tool: tool.name,
            via,
            ...(caller.grantId ? { grantId: caller.grantId } : {}),
            ...(caller.keyId ? { keyId: caller.keyId } : {})
        }
    });
}
