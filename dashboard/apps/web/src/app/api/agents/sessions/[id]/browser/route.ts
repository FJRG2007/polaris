/**
 * /api/agents/sessions/:id/browser - the session's worker browser.
 *
 * GET streams its frames and state as length-prefixed packets
 * (`session-browser-protocol.ts`); POST relays one input event from the
 * person. Both only for the session's owner: the browser may be signed in to
 * something on the agent's behalf, and steering it is acting as the owner, so
 * a reader the session was shared with gets neither.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import { getSession } from "@/lib/agents/session-service";
import { backgroundUser, sessionCan } from "@/lib/session";
import type { BrowserFailure } from "@/lib/agents/session-browser";
import { browserInputSchema } from "@/lib/agents/session-browser-protocol";
import { BrowserError, openBrowserStream, sendBrowserInput } from "@/lib/agents/session-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAILURE_KEYS = {
    gone: { key: "errors.browserGone", status: 404 },
    closed: { key: "errors.browserClosed", status: 409 },
    agentDriving: { key: "errors.browserAgentDriving", status: 409 },
    noBrowser: { key: "errors.browserNoBrowser", status: 409 },
    refused: { key: "errors.browserRefused", status: 400 },
    unreachable: { key: "errors.browserUnreachable", status: 502 }
} as const satisfies Record<BrowserFailure, { key: string; status: number }>;

async function owned(id: string): Promise<boolean> {
    const user = await backgroundUser();
    return Boolean(user && (await sessionCan(user, "agents.read")) && (await getSession(id, user.id)));
}

async function failed(error: unknown): Promise<Response> {
    const failure = error instanceof BrowserError ? error.failure : "unreachable";
    if (!(error instanceof BrowserError)) console.warn("polaris: the session browser failed:", error);
    const { key, status } = FAILURE_KEYS[failure];
    return Response.json({ error: (await readerWords("api"))(key), failure }, { status });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    if (!(await owned(id)))
        return Response.json({ error: (await readerWords("api"))("errors.unauthorized") }, { status: 401 });
    try {
        const stream = await openBrowserStream(id, request.signal);
        return new Response(stream, {
            headers: {
                "content-type": "application/octet-stream",
                "cache-control": "no-store",
                "x-accel-buffering": "no"
            }
        });
    } catch (error) {
        return failed(error);
    }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    if (!(await owned(id)))
        return Response.json({ error: (await readerWords("api"))("errors.unauthorized") }, { status: 401 });
    const parsed = browserInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return Response.json({ error: (await readerWords("api"))("errors.invalidRequest") }, { status: 400 });
    try {
        await sendBrowserInput(id, parsed.data, request.signal);
        return Response.json({ ok: true });
    } catch (error) {
        return failed(error);
    }
}
