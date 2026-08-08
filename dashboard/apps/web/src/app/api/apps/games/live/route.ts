import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { listGameServerLive } from "@/lib/apps/games-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is on each server right now. Apart from the list itself because it is a
 *  round trip into every running container: the table is painted from the other
 *  endpoint and only the player counts wait on this one. */
export async function GET(): Promise<Response> {
    const user = await requirePermission("games.read");
    try {
        return NextResponse.json({ servers: await listGameServerLive(user.id) });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read your game servers" },
            { status: 400 }
        );
    }
}
