/**
 * The connectivity record, for the Watch > Connectivity screen.
 *
 * One read: the current state, the period summaries, the last year of outages
 * and the monthly roll-up of the years before. The screen paints its chrome
 * first and fills itself from here, and polls it while open so the state at the
 * top stays live.
 *
 * Administrators only, like the "cannot reach the internet" alert it records.
 * Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { connectivityReport } from "@/lib/connectivity/outage-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await connectivityReport());
}
