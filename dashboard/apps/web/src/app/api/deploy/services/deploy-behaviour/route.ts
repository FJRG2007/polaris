// a service's deploy behaviour. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { deployBehaviourAction } from "@/app/(app)/apps/deploy/deploy-behaviour-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ applicationId: z.string().trim().min(1).max(200) }),
    ({ applicationId }) => deployBehaviourAction(applicationId)
);
