import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";

import { readCallPorts } from "@/lib/chat/call-reach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The call ports and whether they reach this machine.
 *
 * Read by the Domains card while somebody is in their router: the alternative to
 * knocking from here is a badge that keeps saying "not confirmed" until they
 * reload, or until a call from outside happens to work. The knock is rate
 * limited in `readCallPorts`, so a page left open costs one attempt every thirty
 * seconds however often it asks.
 *
 * `?probe=1` turns the knocking on, and the card leaves it off for its first
 * read: knocking on a closed port waits out a timeout, and the card has to be on
 * screen before it starts.
 */
export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const probe = new URL(request.url).searchParams.get("probe") === "1";
    try {
        return NextResponse.json(await readCallPorts(probe));
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the call ports" },
            { status: 400 }
        );
    }
}
