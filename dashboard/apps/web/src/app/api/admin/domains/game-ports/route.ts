import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { readGamePorts } from "@/lib/apps/games-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The game ports and what is still in the way of them, knocking on the ones not
 * proven yet on the way.
 *
 * Polled by the Domains card, which is the whole point: an operator who has just
 * created the forward is looking at the page while they do it, and the alternative
 * to this is a badge that keeps saying "not confirmed" until somebody reloads or a
 * player happens to join. The knock itself is rate limited in `probeReach`, so a
 * page left open costs one attempt every thirty seconds however often it asks.
 */
export async function GET(): Promise<Response> {
    await requireAdmin();
    try {
        return NextResponse.json(await readGamePorts(true));
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the game ports" },
            { status: 400 }
        );
    }
}
