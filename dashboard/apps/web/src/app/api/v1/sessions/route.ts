/**
 * GET  /api/v1/sessions - the agent sessions this key reaches, newest first.
 * POST /api/v1/sessions - start one, with its first prompt.
 *
 * Started through the same admission as the screen: over a ceiling the session
 * queues rather than starts, and `queuedAt` says its place in line.
 */

import * as sdk from "@polaris/sdk";
import { listSessions } from "@/lib/agents/session-service";
import { sessionCursor } from "@/lib/agents/session-cursor";
import { readBody, queryOf } from "@/lib/deploy/api/http";
import { publicSession, startAgentSession } from "@/lib/agents/session-api";
import { answer, sessionApiRoute } from "@/lib/agents/session-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sessions on one page. */
const PAGE = 50;

export const GET = sessionApiRoute("agents.read", false, async ({ principal, url }) => {
    const query = sdk.listSessionsQuery.parse(queryOf(url));
    const rows = await listSessions(principal.userId, {
        live: query.live,
        after: query.after,
        limit: PAGE
    });
    const last = rows[rows.length - 1];
    return answer({
        sessions: rows.map(publicSession),
        next: rows.length === PAGE && last ? sessionCursor(last) : null
    });
});

export const POST = sessionApiRoute("agents.manage", true, async ({ principal, request }) => {
    const body = sdk.createSessionBody.parse(await readBody(request));
    const { session, queuedAt } = await startAgentSession({ userId: principal.userId }, body);
    return answer({ session: publicSession(session), queuedAt }, 201);
});
