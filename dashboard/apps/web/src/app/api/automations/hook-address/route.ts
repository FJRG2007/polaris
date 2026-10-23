// the address a webhook trigger answers on. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { hookAddressAction } from "@/app/(app)/automations/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        automationId: z.string().trim().min(1).max(200),
        nodeId: z.string().trim().min(1).max(200),
        rotation: jsonParam
    }),
    ({ automationId, nodeId, rotation }) => hookAddressAction(automationId, nodeId, rotation)
);
