// A project's promotions, asked again while one runs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listPromotionsAction } from "@/app/(app)/apps/deploy/project-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ projectId: z.string().trim().min(1).max(100) }),
    ({ projectId }) => listPromotionsAction(projectId)
);
