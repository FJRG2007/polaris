// What a database's panel shows, asked again while an upgrade or a copy runs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { databaseOverviewAction } from "@/app/(app)/apps/deploy/database-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ databaseId: z.string().uuid() }), ({ databaseId }) =>
    databaseOverviewAction(databaseId)
);
