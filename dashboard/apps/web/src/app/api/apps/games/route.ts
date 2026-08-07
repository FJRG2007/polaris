import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { listGameServers } from "@/lib/apps/games-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every game server with who is on it right now. Polled by the Game servers
 *  page, which paints its rows from the page's own render and fills the live
 *  numbers in from here. */
export async function GET(): Promise<Response> {
    const user = await requirePermission("games.read");
    try {
        return NextResponse.json({ servers: await listGameServers(user.id) });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read your game servers" },
            { status: 400 }
        );
    }
}
