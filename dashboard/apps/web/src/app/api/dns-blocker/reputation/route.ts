// The DNS blocker's flagged domains, asked as the search changes. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { dnsReputationAction } from "@/app/(app)/apps/network-filter/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    dnsReputationAction(input)
);
