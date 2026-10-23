// one task's detail for its panel. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getTaskDetailAction } from "@/app/(app)/tasks/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ taskId: z.string().trim().min(1).max(200) }),
    ({ taskId }) => getTaskDetailAction(taskId)
);
