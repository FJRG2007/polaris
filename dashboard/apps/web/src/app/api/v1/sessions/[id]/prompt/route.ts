/**
 * POST /api/v1/sessions/{id}/prompt - say the next thing to a session, as typed
 * into its terminal.
 */

import * as sdk from "@polaris/sdk";
import { readBody } from "@/lib/deploy/api/http";
import { promptAgentSession } from "@/lib/agents/session-api";
import { answer, sessionApiRoute, sessionFor } from "@/lib/agents/session-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = sessionApiRoute("agents.manage", true, async (context) => {
    const session = await sessionFor(context);
    const body = sdk.promptSessionBody.parse(await readBody(context.request));
    await promptAgentSession({ userId: context.principal.userId }, session, body.text);
    return answer({ sent: true });
});
