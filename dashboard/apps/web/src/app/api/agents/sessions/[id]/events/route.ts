/**
 * POST /api/agents/sessions/:id/events - a session saying what its agent is doing.
 *
 * Called by the hook script Polaris wrote into the agent's own configuration, on
 * every turn, every tool call and every permission prompt. Nothing on the machine
 * parses the event: the script posts what it was handed and this decides what it
 * means, because a machine running somebody's repository is the last place a
 * parsing bug should be found.
 *
 * The credential is the session's own reporting token, minted once when the
 * session was created and stored only as a hash. It authenticates one session and
 * dies with it, so an event can only ever be written into the session that
 * produced it, and a finished session's token writes nothing at all.
 *
 * Always answers 200 with an empty object, whatever happened. A hook's exit code
 * is a signal to the agent, and Polaris being confused must never be a reason for
 * somebody's agent to change what it was doing.
 */

import { isTaskTool, readTodos, reportedPermissionMode } from "@/lib/agents/session-asks";
import { hookConversation, hookEventFailed, normalizeHookEvent } from "@/lib/agents/session-hooks";
import { hookSubagentRef } from "@/lib/agents/session-subagents";
import {
    recordSessionConversation,
    recordSessionEvents,
    recordSessionTodos,
    recordTaskTool,
    recordReportedMode,
    sessionForToken
} from "@/lib/agents/session-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { isSessionOver, parseHookSequence } from "@polaris/core";
import { after } from "next/server";
import * as history from "@/lib/agents/session-history";
import { deliverNextQueued } from "@/lib/agents/session-prompt-queue";
import { isSignInRefusal, noteRefusedSignIn } from "@/lib/agents/signin-refusal";
import { judgeSessionGoal } from "@/lib/agents/session-goal";
import { handleTurnFailure, noteTurnFinished, turnAccountName } from "@/lib/agents/account-rotation";

/** The events after which the transcript is read. */
const HISTORY_KINDS = new Set(["turn.end", "turn.failed", "tool.end", "tool.failed"]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** As much of a body as any hook has any business sending. A tool input can be a
 *  whole file, and a limit here is what stops one agent's Write call being the
 *  instance's memory problem. */
const MAX_BODY = 256 * 1024;

function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === "bearer" ? rest.join("") : "";
}

/** A fresh response every time: a Response body is a single-use stream, so one
 *  shared object would serve the first hook and throw for every hook after it. */
function acknowledged(): Response {
    return Response.json({}, { status: 200 });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const session = await sessionForToken(bearer(request));
    // The token names a session; the URL names one too. They have to be the same
    // one, or a token would be a way to write into any session on the instance.
    if (!session || session.id !== id)
        return Response.json(
            { error: (await readerWords("api"))("errors.unauthorized") },
            { status: 401 }
        );

    const body = await request.text();
    if (body.length > MAX_BODY) return acknowledged();

    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        return acknowledged();
    }

    // Before the event is read: every hook carries the conversation, including
    // the ones that say nothing about the state. Best effort - a write that
    // failed here is a Resume that waits for the next hook, never a lost event.
    await recordSessionConversation(id, hookConversation(payload)).catch((error) =>
        console.error(`[agent-session] ${id}: could not keep the conversation id`, error)
    );

    // The todo list and the mode ride on the payload too; both best effort.
    const todos = readTodos(payload);
    if (todos) await recordSessionTodos(id, todos).catch(() => undefined);
    else if (isTaskTool(payload)) await recordTaskTool(id, payload).catch(() => undefined);
    const mode = reportedPermissionMode(payload);
    if (mode) await recordReportedMode(id, mode).catch(() => undefined);

    const event = normalizeHookEvent(payload);
    // An event this build cannot place says nothing, and moving the session for a
    // reason no screen could explain is worse than missing it.
    if (!event) return acknowledged();

    // A tool that failed and one that worked arrive through the same event; the
    // outcome is in what the tool answered.
    const kind = event.kind === "tool.end" && hookEventFailed(payload) ? "tool.failed" : event.kind;
    // A turn starting names the account it runs on, so the log says which of
    // several sign-ins did each turn after a switch.
    const subject =
        kind === "prompt" ? ((await turnAccountName(id).catch(() => null)) ?? event.subject) : event.subject;

    const seq = parseHookSequence(request.headers.get("x-polaris-seq"));
    // Which subagent it fired in and the call it belongs to, checked, for the
    // thread's subagent tree.
    const state = await recordSessionEvents(
        id,
        [{ kind, detail: event.detail, subject, ...hookSubagentRef(payload) }],
        seq
    );
    // A finished turn or tool is when the transcript has something new. After
    // the answer, so the hook is never held on a read of the machine; the read
    // is claimed per session, so a burst of tools is one read.
    // A turn the provider refused the credential for: the account is marked
    // refused, so the keys screen and the picker say so, and the session asks
    // for it to be linked again (`polarCodeThread`).
    if (kind === "turn.failed" && isSignInRefusal(event.detail)) after(() => noteRefusedSignIn(id));
    // A usage limit moves the session to the next account and sends the turn
    // again; an overloaded provider gets it again after a wait
    // (`account-rotation.ts`). Read from the whole payload: the stored detail
    // is clipped before the reset time.
    else if (kind === "turn.failed") after(() => handleTurnFailure(id, payload, seq));
    // A finished turn sends the oldest message typed while it ran; with
    // none waiting, it is when a session's /goal is judged and, while it is
    // not met, the next turn sent (`session-goal.ts`). Never both: a queued
    // message is the person's own next turn.
    else if (kind === "turn.end")
        after(async () => {
            await noteTurnFinished(id);
            if (!(await deliverNextQueued(id))) await judgeSessionGoal(id);
        });
    if (state && isSessionOver(state)) after(() => history.syncFinalSessionHistory(id));
    else if (HISTORY_KINDS.has(kind)) after(() => history.syncSessionHistorySoon(id));
    return acknowledged();
}
