import { z } from "zod";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { endedTerminalAccounts } from "@/lib/terminal-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** At most what one sidecar can hold open: every account's cap is far below it. */
const bodySchema = z.object({ userIds: z.array(z.string().uuid()).max(5_000) });

/**
 * Internal-only endpoint the terminal sidecar calls once a minute with every
 * account holding a terminal: the ones whose account was ended since (banned,
 * deleted) are answered, and the sidecar closes their terminals. The fallback
 * for when the web app's own call at the ban never reached the sidecar
 * (VULN-0038). Gated by the same shared secret as `redeem`.
 */
export async function POST(request: Request): Promise<Response> {
    const secret = process.env.POLARIS_AUTH_SECRET ?? "";
    const provided = request.headers.get("x-internal-key") ?? "";
    if (!secret || !safeEqual(provided, secret)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    // i18n-ignore read by a machine, not shown to a person
    if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
    return NextResponse.json({ ended: await endedTerminalAccounts(parsed.data.userIds) });
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}
