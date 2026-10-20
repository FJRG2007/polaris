/**
 * GET /api/polar/usage - what the signed-in person has spent through Polar
 * since the month began, per model and per key. Their own rows only.
 */

import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { polarMonthUsage } from "@/lib/polar/usage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(await polarMonthUsage(user.id));
}
