// The queries running on a database, asked again while its accounts panel is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listDatabaseProcessesAction } from "@/app/(app)/apps/deploy/database-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ databaseId: z.string().uuid() }), ({ databaseId }) =>
    listDatabaseProcessesAction(databaseId)
);
