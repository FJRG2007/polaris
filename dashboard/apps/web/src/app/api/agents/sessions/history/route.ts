// A page of a session's conversation, read again while the page is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { sessionHistoryAction } from "@/components/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    sessionHistoryAction(input)
);
