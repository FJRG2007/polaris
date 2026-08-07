import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { getServerRoster, getServerStatus } from "@/lib/apps/minecraft/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live state of an installed Minecraft server: who is online, where to reach it,
 *  and - when asked for - the ops, whitelist and ban roster. Polled by the app's
 *  panel; the roster costs three reads inside the container, so it is only
 *  gathered for the screen that shows it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const wantsRoster = new URL(request.url).searchParams.get("roster") === "1";
    try {
        const status = await getServerStatus(user.id, id);
        // A server that is not answering has no roster to report, and asking for one
        // would only stack up failing execs behind a poll.
        const roster = wantsRoster && status.answering ? await getServerRoster(user.id, id) : null;
        return NextResponse.json({ status, roster });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
