// The deployed services the guided setup offers, a page at a time. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { pageHostedServicesAction } from "@/app/(app)/analytics/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ cursor: z.string().max(400).optional(), query: z.string().max(120).optional() }),
    (input) => pageHostedServicesAction(input)
);
