// Whether the updates scan found a newer image for a service, read when its panel opens. A route, not an action:
// it rides alongside the freshness read, which asks GitHub (see lib/poll-route).
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { imageUpdateAction } from "@/app/(app)/apps/deploy/glance-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ applicationId: z.string().trim().min(1).max(100) }),
    ({ applicationId }) => imageUpdateAction(applicationId)
);
