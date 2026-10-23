// Every device the DNS blocker saw over a range, asked when the devices screen opens. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { dnsDevicesAction } from "@/app/(app)/apps/network-filter/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    dnsDevicesAction(input)
);
