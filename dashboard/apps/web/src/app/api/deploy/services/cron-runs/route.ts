// a service cron's runs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listServiceCronRunsAction } from "@/app/(app)/apps/deploy/cron-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        applicationId: z.string().trim().min(1).max(200),
        cronId: z.string().trim().min(1).max(200)
    }),
    ({ applicationId, cronId }) => listServiceCronRunsAction(applicationId, cronId)
);
