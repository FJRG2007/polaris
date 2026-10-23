// Which addresses asked the DNS blocker lately, for the check under the router steps. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { dnsClientsAction } from "@/app/(app)/apps/network-filter/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ fresh: z.enum(["true", "false"]).optional() }),
    ({ fresh }) => dnsClientsAction(fresh === "true")
);
