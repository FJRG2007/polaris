import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { redeemTerminalTicket } from "@/lib/terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Internal-only endpoint the deploy terminal sidecar calls to redeem a one-shot
 * ticket. The sidecar runs as a separate process (outside the Next standalone
 * bundle) and so cannot query Prisma itself; it posts the ticket token here over
 * loopback. A shared-secret header (the app's auth secret, available to both
 * processes in the same container) gates it so it is not usable through the
 * public proxy - and the ticket itself is still short-lived and single-use.
 */
export async function POST(request: Request): Promise<Response> {
    const secret = process.env.POLARIS_AUTH_SECRET ?? "";
    const provided = request.headers.get("x-internal-key") ?? "";
    if (!secret || !safeEqual(provided, secret)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) return NextResponse.json({ error: "token required" }, { status: 400 });
    const ticket = await redeemTerminalTicket(body.token);
    if (!ticket) return NextResponse.json({ error: "invalid ticket" }, { status: 401 });
    return NextResponse.json(ticket);
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}
