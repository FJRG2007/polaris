/**
 * GET /api/polar/runs - the signed-in person's Polar chats that are answering,
 * waiting for an approval, or finished unseen, for the marks in the sidebar.
 * Opening a chat marks it seen: its resume request does (`chat/[id]/stream`).
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { listPolarRuns } from "@/lib/polar/runs";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(
        { runs: listPolarRuns(user.id) },
        { headers: { "cache-control": "no-store" } }
    );
}
