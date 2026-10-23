// a database's connection details. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { databaseConnectionAction } from "@/app/(app)/apps/deploy/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ databaseId: z.string().trim().min(1).max(200) }),
    ({ databaseId }) => databaseConnectionAction(databaseId),
    { sameOrigin: true }
);
