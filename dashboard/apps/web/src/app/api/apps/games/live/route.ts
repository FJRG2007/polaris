import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { listGameServerLive } from "@/lib/apps/games-service";
import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is on each server right now. Apart from the list itself because it is a
 *  round trip into every running container: the table is painted from the other
 *  endpoint and only the player counts wait on this one. */
export async function GET(): Promise<Response> {
    const user = await requirePermission("games.read");
    try {
        const servers = await listGameServerLive(user.id);
        // Schedules fire from the cron when one is configured. Sweeping here too
        // means they also fire on an instance that has none, and it costs nothing
        // extra: the read a sleep decision needs is the one just made.
        await sweepGameSchedules(
            user.id,
            new Date(),
            new Map(servers.map((server) => [server.id, server.online]))
        ).catch(() => undefined);
        return NextResponse.json({ servers });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read your game servers" },
            { status: 400 }
        );
    }
}
