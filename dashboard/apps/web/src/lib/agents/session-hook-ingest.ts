/**
 * What a session's hook said, taken in - whichever way it arrived.
 *
 * A container session's hook script posts to the session's HTTP routes
 * (`/api/agents/sessions/:id/events` and `/permission`); a session on
 * somebody's own computer can relay the same payload through its runner's
 * socket (`lib/runners/runner-inbound.ts`). Both land here, so a hook means the
 * same thing however it travelled. The routes that translate a tool's own
 * webhook into the same payload (`codewhale`) land here too, so they cannot
 * drift on what an event means. Callers have already authenticated the
 * session; nothing here checks who is asking.
 *
 * Called inside a request: the follow-up work is scheduled with `after()`.
 */

import { claudeCallResource, matchingRule, rulesOf } from "@/lib/polar/agents/permissions";
import { sessionEndIsSwap } from "@/lib/agents/hook-activity";
import { isTaskTool, readTodos, reportedPermissionMode } from "@/lib/agents/session-asks";
import { hookConversation, hookEventFailed, normalizeHookEvent } from "@/lib/agents/session-hooks";
import { hookSubagentRef } from "@/lib/agents/session-subagents";
import {
    recordSessionConversation,
    recordSessionEvents,
    recordSessionTodos,
    recordTaskTool,
    recordReportedMode
} from "@/lib/agents/session-service";
import { isSessionOver } from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";
import { after } from "next/server";
import * as history from "@/lib/agents/session-history";
import { deliverNextQueued } from "@/lib/agents/session-prompt-queue";
import { isSignInRefusal, noteRefusedSignIn } from "@/lib/agents/signin-refusal";
import { judgeSessionGoal } from "@/lib/agents/session-goal";
import { handleTurnFailure, noteTurnFinished, turnAccountName } from "@/lib/agents/account-rotation";
import { pushPermissionRequest } from "@/lib/agents/agent-notices";
import * as permissions from "@/lib/agents/session-permissions";
import * as asks from "@/lib/agents/session-asks";
import { dispatchSessionHook } from "@/lib/polar/custom-tools/plugins";
import { snapshotTypedPrompt } from "@/lib/agents/session-runtime";

/** The events after which the transcript is read. */
const HISTORY_KINDS = new Set(["turn.end", "turn.failed", "tool.end", "tool.failed"]);

/** A session as the caller that authenticated it found it. */
export interface HookSession {
    readonly id: string;
    readonly cli: string;
}

/** Take in one lifecycle hook payload. Never throws for a payload it does not
 *  understand: a hook's outcome must not change what the agent does. `seq` is
 *  when the hook ran, in nanoseconds (`parseHookSequence`), or null. */
export async function ingestHookPayload(session: HookSession, payload: unknown, seq: bigint | null): Promise<void> {
    const { id } = session;
    await recordSessionConversation(id, hookConversation(payload)).catch((error) =>
        console.error(`[agent-session] ${id}: could not keep the conversation id`, error)
    );

    const todos = readTodos(payload);
    if (todos) await recordSessionTodos(id, todos).catch(() => undefined);
    else if (isTaskTool(payload)) await recordTaskTool(id, payload).catch(() => undefined);
    const mode = reportedPermissionMode(payload);
    if (mode) await recordReportedMode(id, mode).catch(() => undefined);

    const event = normalizeHookEvent(payload);
    if (!event) return;

    // A session end that only swapped the conversation (Droid's /clear,
    // Kimchi's reload or fork) leaves the agent running, like Claude's /clear.
    const kind =
        event.kind === "tool.end" && hookEventFailed(payload)
            ? "tool.failed"
            : event.kind === "session.end" && sessionEndIsSwap(session.cli, payload)
              ? "session.clear"
              : event.kind;
    const subject =
        kind === "prompt" ? ((await turnAccountName(id).catch(() => null)) ?? event.subject) : event.subject;

    const state = await recordSessionEvents(
        id,
        [{ kind, detail: event.detail, subject, ...hookSubagentRef(payload) }],
        seq
    );
    // The owner's plugins hear it after it is recorded, never in its way.
    after(() => dispatchSessionHook(id, kind, { tool: event.subject, detail: event.detail }).catch(() => undefined));
    // A prompt typed straight into the terminal gets its undo point here.
    if (kind === "prompt") after(() => snapshotTypedPrompt(id, event.detail).catch(() => undefined));
    // What the turn left in the deliverables folder gets its version.
    if (kind === "turn.end")
        after(async () => {
            const { captureSessionArtifacts } = await import("./session-artifacts");
            await captureSessionArtifacts(id, true);
        });
    if (kind === "turn.failed" && isSignInRefusal(event.detail)) after(() => noteRefusedSignIn(id));
    else if (kind === "turn.failed") after(() => handleTurnFailure(id, payload, seq));
    else if (kind === "turn.end")
        after(async () => {
            await noteTurnFinished(id);
            if (!(await deliverNextQueued(id))) await judgeSessionGoal(id);
        });
    if (state && isSessionOver(state)) after(() => history.syncFinalSessionHistory(id));
    else if (HISTORY_KINDS.has(kind)) after(() => history.syncSessionHistorySoon(id));
}

/**
 * A permission or question hook, held until somebody answers it on the
 * session (or it times out). Resolves to the JSON the hook prints back to the
 * agent; an empty object is "no decision", which leaves the agent to ask in its
 * own terminal.
 */
export async function decidePermissionHook(
    id: string,
    payload: unknown,
    signal?: AbortSignal
): Promise<Record<string, unknown>> {
    const question = asks.readAsk(payload);
    if (question) {
        try {
            const tool = question.ask.kind === "plan" ? "ExitPlanMode" : "AskUserQuestion";
            const requestId = await permissions.openPermissionRequest(id, {
                tool,
                detail: question.ask.kind === "plan" ? "" : question.ask.questions[0]!.question,
                suggestions: null,
                input: question.raw as Prisma.InputJsonValue
            });
            void pushPermissionRequest(id, requestId, question.ask.kind === "plan" ? tool : question.ask.questions[0]!.question, false);
            const answer = await permissions.awaitPermission(requestId, id, permissions.PERMISSION_WAIT_MS, signal);
            return asks.askDecision(tool, answer.status, answer.input, answer.answer) as Record<string, unknown>;
        } catch (error) {
            console.error(`[agent-session] ${id}: question could not be relayed:`, error);
            return {};
        }
    }
    const asked = permissions.readPermissionRequest(payload);
    if (!asked || asks.isAskTool(asked.tool)) return {};
    // The Polar agent's rules settle what they name, as OpenCode's would,
    // before anybody is asked (`lib/polar/agents/permissions`).
    const ruled = await agentRuleDecision(id, payload).catch(() => null);
    if (ruled) return permissions.hookDecision(ruled, asked.tool, null) as Record<string, unknown>;

    try {
        const requestId = await permissions.openPermissionRequest(id, asked);
        void dispatchSessionHook(id, "permission.request", { tool: asked.tool, detail: asked.detail }).catch(() => undefined);
        void pushPermissionRequest(id, requestId, asked.detail);
        const answer = await permissions.awaitPermission(requestId, id, permissions.PERMISSION_WAIT_MS, signal);
        return permissions.hookDecision(answer.status, answer.tool, answer.suggestions) as Record<string, unknown>;
    } catch (error) {
        console.error(`[agent-session] ${id}: permission prompt could not be relayed:`, error);
        return {};
    }
}

/** "allow" or "deny" when the session's agent rules settle this request. */
async function agentRuleDecision(id: string, payload: unknown): Promise<"allow" | "deny" | null> {
    const row = await prisma.agentSession.findUnique({ where: { id }, select: { agentPermission: true } });
    const rules = rulesOf(row?.agentPermission);
    if (rules.length === 0) return null;
    const body = (payload ?? {}) as { tool_name?: unknown; tool_input?: unknown };
    if (typeof body.tool_name !== "string") return null;
    const input =
        body.tool_input && typeof body.tool_input === "object"
            ? (body.tool_input as Record<string, unknown>)
            : null;
    const call = claudeCallResource(body.tool_name, input);
    const effect = matchingRule(call.action, call.resource, rules)?.effect;
    return effect === "allow" || effect === "deny" ? effect : null;
}

/** The bearer token a hook request carries, or empty. */
export function hookBearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === "bearer" ? rest.join("") : "";
}
