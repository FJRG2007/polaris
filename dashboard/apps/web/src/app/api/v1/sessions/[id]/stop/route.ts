/**
 * POST /api/v1/sessions/{id}/stop - end a session, the way Stop on the screen
 * does: a queued one leaves the line, a running one keeps its work the way
 * every stop keeps it, and whatever slot it frees goes to whoever is waiting.
 */

import { after } from "next/server";
import * as core from "@polaris/core";
import { stopSession } from "@/lib/agents/session-runtime";
import { cancelQueued, sweepSessionQueue } from "@/lib/agents/session-queue";
import { answer, sessionApiRoute, sessionFor } from "@/lib/agents/session-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = sessionApiRoute("agents.manage", true, async (context) => {
    const session = await sessionFor(context);
    // Stopping one that has already ended is already done.
    if (core.isSessionOver(session.state)) return answer({ stopped: true });
    if (!(await cancelQueued(session.id))) await stopSession(session.id);
    after(() => sweepSessionQueue().catch(() => 0));
    return answer({ stopped: true });
});
