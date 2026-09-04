import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";

import { readGamePorts } from "@/lib/apps/games-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The game ports and what is still in the way of them, knocking on the ones not
 * proven yet when asked to.
 *
 * Read by the Domains card, which is the whole point: an operator who has just
 * created the forward is looking at the page while they do it, and the alternative
 * to this is a badge that keeps saying "not confirmed" until somebody reloads or a
 * player happens to join. The knock itself is rate limited in `probeReach`, so a
 * page left open costs one attempt every thirty seconds however often it asks.
 *
 * `?probe=1` is what turns the knocking on, and the card leaves it off for its
 * first read: knocking on a closed port waits out a timeout, and the card has to
 * be on screen before it starts. Anything other than `1` reads as off, so a
 * mistyped parameter costs a page nothing.
 */
export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const probe = new URL(request.url).searchParams.get("probe") === "1";
    try {
        return NextResponse.json(await readGamePorts(probe));
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the game ports" },
            { status: 400 }
        );
    }
}
