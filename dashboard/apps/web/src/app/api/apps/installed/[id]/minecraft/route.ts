import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { getServerFirewall, getServerRoster, getServerStatus } from "@/lib/apps/minecraft/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live state of an installed Minecraft server: who is online, where to reach it,
 *  and - when asked for - the ops, whitelist and ban roster. Polled by the app's
 *  panel; the roster costs three reads inside the container, so it is only
 *  gathered for the screen that shows it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requirePermission("games.read");
    const { id } = await params;
    const wantsRoster = new URL(request.url).searchParams.get("roster") === "1";
    try {
        const status = await getServerStatus(user.id, id);
        // A server that is not answering has no roster to report, and asking for one
        // would only stack up failing execs behind a poll.
        const [roster, firewall] = await Promise.all([
            wantsRoster && status.answering ? getServerRoster(user.id, id) : null,
            wantsRoster ? getServerFirewall(user.id, id).catch(() => null) : null
        ]);
        return NextResponse.json({ status, roster, firewall });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
