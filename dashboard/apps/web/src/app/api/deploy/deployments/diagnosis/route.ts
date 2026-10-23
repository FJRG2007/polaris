// a failed deployment's likely cause. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { deploymentDiagnosisAction } from "@/app/(app)/apps/deploy/fix-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ deploymentId: z.string().trim().min(1).max(200) }),
    ({ deploymentId }) => deploymentDiagnosisAction(deploymentId)
);
