/**
 * An Agent Client Protocol permission request, answered through the session's
 * own permission prompts (`session-permissions.ts`): shown on the session page
 * and pushed to the owner's devices with Allow / Deny, exactly as a Claude
 * hook's request is. The person's answer becomes the agent's offered option of
 * the matching kind; no answer in time is a cancellation, the protocol's "no
 * decision".
 */

import type * as acp from "@agentclientprotocol/sdk";
import { toolInputSummary } from "../transcript-decoders";
import {
    awaitPermission,
    openPermissionRequest,
    PERMISSION_WAIT_MS,
    type PermissionStatus
} from "../session-permissions";

/** The option kinds an answer may become, best first. "always" falls back to
 *  once rather than to nothing, and never the other way round: a once answer
 *  must not grant a standing rule. */
const KINDS: Record<"allow" | "always" | "deny", readonly acp.PermissionOptionKind[]> = {
    allow: ["allow_once"],
    always: ["allow_always", "allow_once"],
    deny: ["reject_once", "reject_always"]
};

/** The offered option an answer stands for, or null for no decision. Pure. */
export function optionFor(status: PermissionStatus, options: readonly acp.PermissionOption[]): string | null {
    if (status === "pending" || status === "expired") return null;
    for (const kind of KINDS[status]) {
        const option = options.find((candidate) => candidate.kind === kind);
        if (option) return option.optionId;
    }
    return null;
}

/** What the prompt names: the tool call's title, else its kind. Pure. */
export function promptFor(request: acp.RequestPermissionRequest): { tool: string; detail: string } {
    const call = request.toolCall;
    const tool = (call.title?.trim() || call.kind || "tool").slice(0, 80);
    return { tool, detail: toolInputSummary(call.rawInput) };
}

/** The `onPermission` handler for a session's ACP client. */
export function sessionPermissionHandler(
    sessionId: string,
    waitMs: number = PERMISSION_WAIT_MS
): (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<string | null> {
    return async (request, signal) => {
        const { tool, detail } = promptFor(request);
        const id = await openPermissionRequest(sessionId, { tool, detail, suggestions: null });
        const answered = await awaitPermission(id, sessionId, waitMs, signal);
        return optionFor(answered.status, request.options);
    };
}
