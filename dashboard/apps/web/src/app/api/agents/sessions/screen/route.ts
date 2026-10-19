// What a starting agent session's terminal shows, asked again until it is up. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { sessionScreenAction } from "@/app/(app)/apps/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ sessionId: z.string().trim().min(1).max(100) }),
    ({ sessionId }) => sessionScreenAction(sessionId)
);
