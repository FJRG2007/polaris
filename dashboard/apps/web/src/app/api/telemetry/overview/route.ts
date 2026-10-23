// the projects and the open project's faults. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { telemetryOverviewAction } from "@/app/(app)/apps/telemetry/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const overviewSchema = z.object({
    projectId: z.string().max(200).nullish(),
    status: z.string().max(100).optional(),
    query: z.string().max(500).optional()
});

export const GET = pollRoute(z.object({ input: jsonParam.pipe(overviewSchema) }), ({ input }) =>
    telemetryOverviewAction(input)
);
