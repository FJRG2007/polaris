// one fault's detail. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { openIssueAction } from "@/app/(app)/apps/telemetry/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        projectId: z.string().trim().min(1).max(200),
        issueId: z.string().trim().min(1).max(200)
    }),
    ({ projectId, issueId }) => openIssueAction(projectId, issueId)
);
