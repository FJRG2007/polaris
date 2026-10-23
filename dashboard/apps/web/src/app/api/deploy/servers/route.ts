// the machines a service can deploy to. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listDeployServersAction } from "@/app/(app)/apps/deploy/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ environmentId: z.string().trim().min(1).max(200).optional() }),
    ({ environmentId }) => listDeployServersAction(environmentId)
);
