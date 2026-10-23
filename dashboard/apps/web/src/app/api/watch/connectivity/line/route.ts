/**
 * The line's charts for Watch > Connectivity: latency, loss and uptime over a
 * range (`?range=24h|7d|30d|90d`), and the public address's history.
 *
 * Administrators only, like the record it sits beside, so the report goes out
 * whole, addresses included. Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { lineReport } from "@/lib/connectivity/line-report";
import { isLineRange } from "@/lib/connectivity/line-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const range = new URL(request.url).searchParams.get("range") ?? "24h";
    if (!isLineRange(range)) return NextResponse.json({ error: "Unknown range" }, { status: 400 });
    return NextResponse.json(await lineReport(range));
}
