// A project's environments at a glance, asked again while its page is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { projectGlanceAction } from "@/app/(app)/apps/deploy/glance-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ projectId: z.string().trim().min(1).max(100) }),
    ({ projectId }) => projectGlanceAction(projectId)
);
