// the Discord bot channel to ask about servers. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { pollRoute } from "@/lib/poll-route";
import { firstDiscordChannelAction } from "@/app/(app)/admin/inbox/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = pollRoute(z.object({}), () => firstDiscordChannelAction());

// Whoever answers the inbox, said here as every admin route says it; the action checks again.
export async function GET(request: Request): Promise<Response> {
    const refused = await apiPermission("inbox.read");
    if (refused instanceof Response) return refused;
    return read(request);
}
