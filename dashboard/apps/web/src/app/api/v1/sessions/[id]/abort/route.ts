/**
 * POST /api/v1/sessions/{id}/abort - stop the turn the agent is on, as Escape
 * does in its terminal. The session stays up for the next prompt.
 */

import * as core from "@polaris/core";
import { interruptSession } from "@/lib/agents/session-runtime";
import { SessionRefusal } from "@/lib/agents/session-service";
import { answer, sessionApiRoute, sessionFor } from "@/lib/agents/session-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = sessionApiRoute("agents.manage", true, async (context) => {
    const session = await sessionFor(context);
    if (core.isSessionOver(session.state)) throw new SessionRefusal("That session has ended.");
    if (core.isSessionQueued(session.state))
        throw new SessionRefusal("That session has not started yet. Stop it instead.");
    await interruptSession(session.id);
    return answer({ aborted: true });
});
