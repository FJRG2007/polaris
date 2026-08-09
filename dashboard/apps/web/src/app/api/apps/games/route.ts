import { NextResponse } from "next/server";
import { requirePermissionAny } from "@/lib/session";
import { listGameServerFacts } from "@/lib/apps/games-service";
import { reachableInstallIds } from "@/lib/apps/install-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every game server this person runs or was given access to, and what Polaris
 *  already knows about it: where it runs, where a player connects, whether it is
 *  meant to be up. Read from records rather than from containers, so the page
 *  fills its table in one hop and only the player counts wait on the servers
 *  themselves. */
export async function GET(): Promise<Response> {
    const user = await requirePermissionAny("games.read");
    try {
        const granted = await reachableInstallIds(user, "games.read");
        return NextResponse.json({ servers: await listGameServerFacts(user.id, granted) });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read your game servers" },
            { status: 400 }
        );
    }
}
