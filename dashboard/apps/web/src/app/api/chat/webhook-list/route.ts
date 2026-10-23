// a channel's webhooks. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listWebhooksAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ channelId: z.string().trim().min(1).max(200) }),
    ({ channelId }) => listWebhooksAction(channelId)
);
