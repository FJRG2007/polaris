// how far a variable group reaches. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { variableGroupReachAction } from "@/app/(app)/apps/deploy/variable-group-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ groupId: z.string().trim().min(1).max(200) }),
    ({ groupId }) => variableGroupReachAction({ groupId })
);
