// An automation run, asked again until it finishes. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getRunAction } from "@/app/(app)/automations/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ runId: z.string().trim().min(1).max(100) }), ({ runId }) =>
    getRunAction(runId)
);
