// the plan for moving a service home. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { moveHomePlanAction } from "@/app/(app)/apps/deploy/external-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        projectId: z.string().trim().min(1).max(200),
        serviceId: z.string().trim().min(1).max(200)
    }),
    ({ projectId, serviceId }) => moveHomePlanAction(projectId, serviceId)
);
