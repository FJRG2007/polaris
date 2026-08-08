import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { readWorldView } from "@/lib/apps/minecraft/world-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A game server's maps and the archives beside them.
 *
 * Its own route rather than a slice of the panel's poll: reading it walks the
 * world folder to measure it, which takes seconds on a large map and must never
 * ride on a five-second poll that only wanted the player list. Both the server's
 * own World screen and the Backups app read it here, so the two can never
 * disagree about what is on disk.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requirePermission("games.read");
    const { id } = await params;
    try {
        return NextResponse.json(await readWorldView(user.id, id));
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the world" },
            { status: 400 }
        );
    }
}
