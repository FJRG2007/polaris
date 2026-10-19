// A channel's link state, asked again while it is being linked. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { channelStateAction } from "@/app/(app)/admin/inbox/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ channelId: z.string().trim().min(1).max(100) }),
    ({ channelId }) => channelStateAction(channelId)
);
