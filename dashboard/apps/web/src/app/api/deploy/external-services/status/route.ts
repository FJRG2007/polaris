// An outside service's build state, asked again while it builds. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { refreshExternalServiceAction } from "@/app/(app)/apps/deploy/external-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ projectId: z.string().trim().min(1).max(100), id: z.string().uuid() }),
    ({ projectId, id }) => refreshExternalServiceAction(projectId, id)
);
