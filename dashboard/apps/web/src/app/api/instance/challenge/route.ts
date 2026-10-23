/**
 * Sign a client's nonce together with the address it was asked on.
 *
 * What lets a client tell this Polaris from another one answering on the same
 * name: only the holder of the private key the client stored can produce the
 * signature (see `lib/instance-identity`). Public, rate-limited per address, and
 * never given a cookie.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { requestOrigin } from "@/lib/domain-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { ensureInstanceIdentity, OPEN_HEADERS, signChallenge } from "@/lib/instance-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 30;
const WINDOW_MS = 60_000;

const challengeSchema = z.object({ nonce: z.string().trim().regex(/^[A-Za-z0-9_-]{22,128}$/) }).strict();

export function OPTIONS(): Response {
    return new Response(null, { status: 204, headers: OPEN_HEADERS });
}

export async function POST(request: Request): Promise<Response> {
    const limited = await rateLimit(`instance-challenge:${(await clientIp()) ?? "unknown"}`, LIMIT, WINDOW_MS);
    if (!limited.ok) {
        return NextResponse.json(
            { error: "Too many requests. Try again in a minute." },
            { status: 429, headers: { ...OPEN_HEADERS, "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } }
        );
    }
    const parsed = challengeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "Send a nonce to sign." }, { status: 400, headers: OPEN_HEADERS });
    }
    const identity = await ensureInstanceIdentity();
    if (!identity) {
        return NextResponse.json({ error: "This Polaris has no identity yet." }, { status: 503, headers: OPEN_HEADERS });
    }
    const origin = requestOrigin(request);
    const { nonce } = parsed.data;
    return NextResponse.json(
        { id: identity.id, origin, nonce, signature: signChallenge(identity, origin, nonce) },
        { headers: OPEN_HEADERS }
    );
}
