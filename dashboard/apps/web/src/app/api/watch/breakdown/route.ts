// a chart's breakdown by subject. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { subjectBreakdownAction } from "@/app/(app)/breakdown-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    subjectBreakdownAction(input)
);
