/**
 * What a session's hook said, taken in - whichever way it arrived.
 *
 * A container session's hook script posts to the session's HTTP routes
 * (`/api/agents/sessions/:id/events` and `/permission`); a session on
 * somebody's own computer can relay the same payload through its runner's
 * socket (`lib/runners/runner-inbound.ts`). Both land here, so a hook means the
 * same thing however it travelled. Callers have already authenticated the
 * session; nothing here checks who is asking.
 *
 * Called inside a request: the follow-up work is scheduled with `after()`.
 */

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
import type { Prisma } from "@polaris/db";
import { after } from "next/server";
import * as history from "@/lib/agents/session-history";
import { deliverNextQueued } from "@/lib/agents/session-prompt-queue";
import { isSignInRefusal, noteRefusedSignIn } from "@/lib/agents/signin-refusal";
import { judgeSessionGoal } from "@/lib/agents/session-goal";
import { handleTurnFailure, noteTurnFinished, turnAccountName } from "@/lib/agents/account-rotation";
import { pushPermissionRequest } from "@/lib/agents/agent-notices";
import * as permissions from "@/lib/agents/session-permissions";
import * as asks from "@/lib/agents/session-asks";

/** The events after which the transcript is read. */
const HISTORY_KINDS = new Set(["turn.end", "turn.failed", "tool.end", "tool.failed"]);

/** Take in one lifecycle hook payload. Never throws for a payload it does not
 *  understand: a hook's outcome must not change what the agent does. */
export async function ingestHookPayload(id: string, payload: unknown, seq: bigint | null): Promise<void> {
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

    const kind = event.kind === "tool.end" && hookEventFailed(payload) ? "tool.failed" : event.kind;
    const subject =
        kind === "prompt" ? ((await turnAccountName(id).catch(() => null)) ?? event.subject) : event.subject;

    const state = await recordSessionEvents(
        id,
        [{ kind, detail: event.detail, subject, ...hookSubagentRef(payload) }],
        seq
    );
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

    try {
        const requestId = await permissions.openPermissionRequest(id, asked);
        void pushPermissionRequest(id, requestId, asked.detail);
        const answer = await permissions.awaitPermission(requestId, id, permissions.PERMISSION_WAIT_MS, signal);
        return permissions.hookDecision(answer.status, answer.tool, answer.suggestions) as Record<string, unknown>;
    } catch (error) {
        console.error(`[agent-session] ${id}: permission prompt could not be relayed:`, error);
        return {};
    }
}
