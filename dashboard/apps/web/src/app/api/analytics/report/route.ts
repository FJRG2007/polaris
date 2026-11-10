// One Analytics report past the overview - events, revenue, a funnel, journeys,
// goals, retention, the visits one by one. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { runAnalyticsReportAction } from "@/app/(app)/analytics/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        scopeType: z.string().trim().min(1).max(200),
        scopeId: z.string().max(200),
        range: z.string().trim().min(1).max(200),
        filters: z.string().max(4000).optional(),
        request: z.string().min(2).max(8000)
    }),
    (input) => runAnalyticsReportAction(input)
);
