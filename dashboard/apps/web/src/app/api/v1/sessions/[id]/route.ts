/**
 * GET /api/v1/sessions/{id} - one session, and where its event stream is now,
 * so a reader can follow only what comes after.
 */

import * as sdk from "@polaris/sdk";
import { publicSession, streamTail } from "@/lib/agents/session-api";
import { answer, sessionApiRoute, sessionFor } from "@/lib/agents/session-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = sessionApiRoute("agents.read", false, async (context) => {
    const session = await sessionFor(context);
    return answer({
        session: publicSession(session),
        cursor: sdk.streamCursor(await streamTail(session.id))
    });
});
