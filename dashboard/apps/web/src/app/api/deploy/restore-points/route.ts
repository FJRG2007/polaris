// the points a thing can be restored to. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { listHistoryAction } from "@/app/(app)/apps/deploy/restore-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The JSON is the action's own to check: it parses what it is handed with its schema.
export const GET = pollRoute(z.object({ target: jsonParam }), ({ target }) =>
    listHistoryAction(target as Parameters<typeof listHistoryAction>[0])
);
