/**
 * "Is this a Polaris?", for the extension and the desktop app while somebody is
 * typing the address of one.
 *
 * Before this, both took any host that answered at all: `test.com` was added as
 * a server and only failed later, with nothing on screen to say why. They now
 * ask this route first and accept the address only when the answer has this
 * exact shape - a product marker and the protocol version the clients speak.
 *
 * Public and unauthenticated, because nobody is signed in to a server they have
 * not added yet. It says nothing about this deployment beyond being Polaris: no
 * release, no addresses, no names. Open to every origin with no credentials so
 * an extension page can read it before it holds a permission for the host, and
 * cacheable for a few minutes because the answer never changes between builds.
 * Rate-limited per address all the same, so it is not a free echo to hammer.
 *
 * Installs that predate this route answer 404 here; the clients then fall back
 * to `/api/instance` and `/api/health`, which those installs already serve.
 */

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 60;
const WINDOW_MS = 60_000;
const CACHE_SECONDS = 300;

const OPEN = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "accept"
} as const;

export function OPTIONS(): Response {
    return new Response(null, { status: 204, headers: { ...OPEN, "access-control-max-age": "86400" } });
}

export async function GET(): Promise<Response> {
    const limited = await rateLimit(`identity:${(await clientIp()) ?? "unknown"}`, LIMIT, WINDOW_MS);
    if (!limited.ok) {
        return NextResponse.json(
            { error: "Too many requests. Try again in a minute." },
            {
                status: 429,
                headers: {
                    ...OPEN,
                    "cache-control": "no-store",
                    "retry-after": String(Math.ceil(limited.retryAfterMs / 1000))
                }
            }
        );
    }
    return NextResponse.json(
        { product: "polaris", protocol: 1 },
        { headers: { ...OPEN, "cache-control": `public, max-age=${CACHE_SECONDS}` } }
    );
}
