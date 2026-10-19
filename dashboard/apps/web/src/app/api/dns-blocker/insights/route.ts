// The DNS blocker's numbers for a filter, asked again while the page is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { queryFilterSchema } from "@/lib/dns-blocker/query-log";
import { dnsInsightsAction } from "@/app/(app)/apps/dns-blocker/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        filter: jsonParam.pipe(queryFilterSchema),
        fresh: z.enum(["true", "false"]).optional()
    }),
    ({ filter, fresh }) => dnsInsightsAction(filter, fresh === "true")
);
