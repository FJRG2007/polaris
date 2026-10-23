// a message quoted into another conversation. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { carriedMessageAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ messageId: z.string().trim().min(1).max(200) }),
    ({ messageId }) => carriedMessageAction(messageId)
);
