import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { retentionPolicy, retentionTotals } from "@/lib/retention-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How many rows each retained table holds, and how many are past their period.
 * Read by the retention screen after its first paint: a whole-table count on the
 * activity and audit tables is a scan, and the page does not wait for it.
 */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await retentionTotals(await retentionPolicy()));
}
