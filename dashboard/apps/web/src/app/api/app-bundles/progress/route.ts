/**
 * How far each app update in flight has got, for the updates screen to poll.
 *
 * A route rather than a server action: the browser sends a page's server
 * actions one at a time, so a poll made that way would wait behind the very
 * update it is meant to follow. Admin-only, like the update itself.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { appsUpdating } from "@/lib/app-bundles/releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const caller = await apiAdmin();
    if (caller instanceof Response) return caller;
    return NextResponse.json(appsUpdating(), { headers: { "cache-control": "no-store" } });
}
