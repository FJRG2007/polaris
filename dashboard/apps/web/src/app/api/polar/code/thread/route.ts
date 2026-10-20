// One agent session as Polar's Code thread shows it, asked again while it runs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { polarCodeThreadAction } from "@/app/(app)/polar/code-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ sessionId: z.string().trim().uuid() }),
    ({ sessionId }) => polarCodeThreadAction(sessionId)
);
