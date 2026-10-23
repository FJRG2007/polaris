// what a machine can offer as a runner. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { probeRunnerHostAction } from "@/app/(app)/apps/runners/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ serverId: z.string().trim().min(1).max(200) }),
    ({ serverId }) => probeRunnerHostAction(serverId)
);
