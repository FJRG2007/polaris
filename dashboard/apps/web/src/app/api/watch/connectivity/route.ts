/**
 * The connectivity record, for the Watch > Connectivity screen.
 *
 * One read: the current state, the period summaries, the last year of outages
 * and the monthly roll-up of the years before. The screen paints its chrome
 * first and fills itself from here, and polls it while open so the state at the
 * top stays live.
 *
 * Administrators, like the "cannot reach the internet" alert it records, and
 * anybody one of them shared it with - who is sent it without the parts that
 * name this network. Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { connectivityReport } from "@/lib/connectivity/outage-tracker";
import { connectivityReach, sharedConnectivityReport } from "@/lib/connectivity/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const caller = await apiUser();
    if (caller instanceof Response) return caller;
    const reach = await connectivityReach(caller);
    if (!reach) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const report = await connectivityReport();
    return NextResponse.json(reach === "admin" ? report : sharedConnectivityReport(report));
}
