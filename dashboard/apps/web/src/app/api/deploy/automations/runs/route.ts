// a project automation's runs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listAutomationRunsAction } from "@/app/(app)/apps/deploy/automation-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        projectId: z.string().trim().min(1).max(200),
        automationId: z.string().trim().min(1).max(200)
    }),
    ({ projectId, automationId }) => listAutomationRunsAction({ projectId, automationId })
);
