/**
 * GET /api/polar/people?q=<name> - people the signed-in person may send a Polar
 * chat to. The same search every people picker uses, so whoever has taken
 * themselves out of it, or blocked the searcher, is not offered here either.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { findPeople } from "@/lib/people-search";
import { rateLimit } from "@/lib/rate-limit-service";

export const dynamic = "force-dynamic";

const querySchema = z.string().trim().min(2).max(100);

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const query = querySchema.safeParse(new URL(request.url).searchParams.get("q"));
    if (!query.success) return NextResponse.json({ results: [], withheld: 0 });
    const limited = await rateLimit(`polar-people:${user.id}`, 60, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    // Not `reachableOnly`: this is not a message, so somebody with the chat
    // switched off can still be sent a Polar conversation.
    const found = await findPeople({ id: user.id }, query.data, { reachableOnly: false });
    return NextResponse.json({ results: found.people, withheld: found.withheld });
}
