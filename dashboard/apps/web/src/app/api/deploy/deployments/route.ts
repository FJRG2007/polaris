// A service's deployments, asked again while one is in flight. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listDeploymentsAction } from "@/app/(app)/apps/deploy/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ applicationId: z.string().trim().min(1).max(100) }),
    ({ applicationId }) => listDeploymentsAction(applicationId)
);
