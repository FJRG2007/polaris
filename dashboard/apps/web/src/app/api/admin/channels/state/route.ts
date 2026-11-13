// A channel's link state, asked again while it is being linked. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { apiPermission } from "@/lib/api-session";
import { channelStateAction } from "@/app/(app)/admin/email/channels/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = pollRoute(
    z.object({ channelId: z.string().trim().min(1).max(100) }),
    ({ channelId }) => channelStateAction(channelId)
);

// Whoever holds the channels, said here as every admin route says it; the action checks again.
export async function GET(request: Request): Promise<Response> {
    const refused = await apiPermission("inbox.read");
    if (refused instanceof Response) return refused;
    return read(request);
}
