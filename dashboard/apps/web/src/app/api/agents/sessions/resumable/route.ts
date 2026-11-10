// Whether a session's agent has exited and can be resumed, asked again while the page is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { sessionResumableAction } from "@/components/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ sessionId: z.string().trim().min(1).max(100) }),
    ({ sessionId }) => sessionResumableAction(sessionId)
);
