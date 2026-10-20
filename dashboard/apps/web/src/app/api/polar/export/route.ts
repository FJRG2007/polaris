/**
 * GET /api/polar/export - every saved Polar chat of the signed-in person as one
 * zip: a Markdown and a JSON file per chat. Temporary chats are not included.
 * Streamed, one chat read at a time; a few per ten minutes per person.
 */

import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import { exportAllThreads, exportNames } from "@/lib/polar/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const limited = await rateLimit(`polar-export:${user.id}`, 5, 10 * 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const stream = await exportAllThreads(user.id, await exportNames());
    const day = new Date().toISOString().slice(0, 10);
    return new Response(stream, {
        headers: {
            ...downloadTicketHeaders(request),
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="polar-chats-${day}.zip"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }
    });
}
