/**
 * GET /api/polar/shares - every Polar chat the signed-in person shares, by link
 * or with people, newest snapshot first: the "Shared links" list.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { listOwnedPolarShares } from "@/lib/polar/share";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json({ shares: await listOwnedPolarShares(user.id) });
}
