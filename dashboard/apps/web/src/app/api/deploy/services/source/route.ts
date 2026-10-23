// a service's source. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { serviceSourceAction } from "@/app/(app)/apps/deploy/source-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ applicationId: z.string().trim().min(1).max(200) }),
    ({ applicationId }) => serviceSourceAction(applicationId)
);
