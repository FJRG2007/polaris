// One deliverable and its versions. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { sessionArtifactAction } from "@/components/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ artifactId: z.string().trim().min(1).max(100) }), ({ artifactId }) =>
    sessionArtifactAction(artifactId)
);
