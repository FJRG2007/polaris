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

import { hookEventFailed, normalizeHookEvent } from "@/lib/agents/session-hooks";
import { recordSessionEvents, sessionForToken } from "@/lib/agents/session-service";

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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const session = await sessionForToken(bearer(request));
    // The token names a session; the URL names one too. They have to be the same
    // one, or a token would be a way to write into any session on the instance.
    if (!session || session.id !== id) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.text();
    if (body.length > MAX_BODY) return acknowledged();

    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        return acknowledged();
    }

    const event = normalizeHookEvent(payload);
    // An event this build cannot place says nothing, and moving the session for a
    // reason no screen could explain is worse than missing it.
    if (!event) return acknowledged();

    // A tool that failed and one that worked arrive through the same event; the
    // outcome is in what the tool answered.
    const kind = event.kind === "tool.end" && hookEventFailed(payload) ? "tool.failed" : event.kind;

    await recordSessionEvents(id, [{ kind, detail: event.detail, subject: event.subject }]);
    return acknowledged();
}
