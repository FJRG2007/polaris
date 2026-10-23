// how an installed app's service redeploys. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { redeployStrategyAction } from "@/app/(app)/apps/installed/[id]/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ installId: z.string().trim().min(1).max(200) }),
    ({ installId }) => redeployStrategyAction(installId)
);
