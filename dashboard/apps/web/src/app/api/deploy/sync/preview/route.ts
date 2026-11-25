// what a sync would change. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { previewSyncAction } from "@/app/(app)/apps/deploy/project-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        sourceEnvironmentId: z.string().trim().min(1).max(200),
        targetEnvironmentId: z.string().trim().min(1).max(200)
    }),
    ({ sourceEnvironmentId, targetEnvironmentId }) =>
        previewSyncAction({ sourceEnvironmentId, targetEnvironmentId })
);
