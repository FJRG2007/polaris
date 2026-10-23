/**
 * Who this Polaris is, for a client that may later reach it on another address.
 *
 * Public and unauthenticated: the id, the public key and the addresses are what a
 * client stores while it is on an address it already trusts, and none of them is
 * a secret. Proof comes from the challenge route beside this one, never from the
 * id. Open to every origin with no credentials, so an extension page can read it
 * before it holds a permission for the server.
 */

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { ensureInstanceIdentity, instanceAddresses, OPEN_HEADERS } from "@/lib/instance-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 60;
const WINDOW_MS = 60_000;

export function OPTIONS(): Response {
    return new Response(null, { status: 204, headers: OPEN_HEADERS });
}

export async function GET(): Promise<Response> {
    const limited = await rateLimit(
        `instance:${(await clientIp()) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!limited.ok) {
        return NextResponse.json(
            { error: "Too many requests. Try again in a minute." },
            {
                status: 429,
                headers: {
                    ...OPEN_HEADERS,
                    "retry-after": String(Math.ceil(limited.retryAfterMs / 1000))
                }
            }
        );
    }
    const identity = await ensureInstanceIdentity();
    if (!identity) {
        return NextResponse.json(
            { error: "This Polaris has no identity yet." },
            { status: 503, headers: OPEN_HEADERS }
        );
    }
    return NextResponse.json(
        {
            version: 1,
            id: identity.id,
            publicKey: identity.publicKey,
            addresses: await instanceAddresses()
        },
        { headers: OPEN_HEADERS }
    );
}
