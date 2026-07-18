/**
 * Update-status endpoint the dashboard polls on an interval. Returns the cached
 * check (refreshed at most every few hours server-side), so many open tabs cost
 * at most one GitHub call per TTL. Authenticated: update state is operator info,
 * not public.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUpdateStatus } from "@/lib/update-service";

export const dynamic = "force-dynamic";

export async function GET() {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const status = await getUpdateStatus();
    return NextResponse.json(status);
}
