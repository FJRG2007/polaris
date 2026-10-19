// A domain's DNS cutover panel, asked again while a step waits. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { cutoverPanelAction } from "@/app/(app)/apps/deploy/dns-cutover-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ domainId: z.string().uuid() }), ({ domainId }) =>
    cutoverPanelAction(domainId)
);
