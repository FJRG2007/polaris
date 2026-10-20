/**
 * GET /api/polar/runs - the signed-in person's Polar chats that are answering,
 * waiting for an approval, or finished unseen, for the marks in the sidebar,
 * and how many may answer at once, for "Ask several" to check its room.
 * Opening a chat marks it seen: its resume request does (`chat/[id]/stream`).
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { POLAR_RUNS_MAX, listPolarRuns } from "@/lib/polar/runs";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(
        { runs: listPolarRuns(user.id), max: POLAR_RUNS_MAX },
        { headers: { "cache-control": "no-store" } }
    );
}
