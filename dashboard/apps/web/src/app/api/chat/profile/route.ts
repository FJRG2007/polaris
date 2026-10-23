// a person's profile as a conversation shows it. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { profileAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        channelId: z.string().trim().min(1).max(200),
        userId: z.string().trim().min(1).max(200)
    }),
    ({ channelId, userId }) => profileAction(channelId, userId)
);
