// The web servers a session runs, for its preview. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { sessionPreviewAction } from "@/components/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ sessionId: z.string().trim().min(1).max(100) }),
    ({ sessionId }) => sessionPreviewAction(sessionId)
);
