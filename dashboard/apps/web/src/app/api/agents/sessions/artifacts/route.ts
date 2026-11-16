// A session's deliverables. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { sessionArtifactsAction } from "@/components/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ sessionId: z.string().trim().min(1).max(100), capture: z.enum(["0", "1"]).default("0") }),
    ({ sessionId, capture }) => sessionArtifactsAction({ sessionId, capture: capture === "1" })
);
