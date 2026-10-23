// The DNS blocker's long-term days for a range, asked when the Overview opens. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { dnsHistoryAction } from "@/app/(app)/apps/network-filter/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    dnsHistoryAction(input)
);
