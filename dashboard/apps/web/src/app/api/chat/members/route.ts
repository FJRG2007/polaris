// who is in a conversation. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listMembersAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ channelId: z.string().trim().min(1).max(200) }),
    ({ channelId }) => listMembersAction(channelId)
);
