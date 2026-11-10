// what a scope's visitors did over a range. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getAnalyticsOverviewAction } from "@/app/(app)/analytics/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        scopeType: z.string().trim().min(1).max(200),
        scopeId: z.string().max(200),
        range: z.string().trim().min(1).max(200),
        filters: z.string().max(4000).optional()
    }),
    ({ scopeType, scopeId, range, filters }) => getAnalyticsOverviewAction({ scopeType, scopeId, range, filters })
);
