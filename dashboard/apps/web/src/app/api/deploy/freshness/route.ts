// How far a service's release is behind its branch, read when its panel opens. A route, not an action: it asks
// GitHub, and an action that waits on GitHub holds every other action from the same tab behind it (see lib/poll-route).
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { deployFreshnessAction } from "@/app/(app)/apps/deploy/glance-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ applicationId: z.string().trim().min(1).max(100) }),
    ({ applicationId }) => deployFreshnessAction(applicationId)
);
