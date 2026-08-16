import { NextResponse } from "next/server";
import { imageTypeOfBytes } from "@/lib/mime";
import { isWorkshopImage } from "@/lib/apps/ark/workshop";
import { requireGameServer } from "@/lib/apps/install-access";

export const runtime = "nodejs";

/**
 * A mod's preview picture, fetched by Polaris rather than by the browser.
 *
 * The rest of this feature is proxied for a reason - the dashboard should not make
 * the operator's machine talk to Steam to render a page - and an `<img src>`
 * pointing straight at Steam's CDN is exactly that: every mods screen would
 * announce to Steam who is looking at it and from where. So the image comes
 * through here, from an address this side has already checked is theirs.
 *
 * Cached hard. A mod's picture changes about never, and the alternative is a
 * request per row per visit through a server that has other work to do.
 */
const CACHE_SECONDS = 24 * 3600;
const TIMEOUT_MS = 8000;
/** Enough for any preview Steam serves, and small enough that this can never be
 *  used to pull something large through the dashboard. */
const MAX_BYTES = 4 * 1024 * 1024;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    await requireGameServer("games.read", id);

    const url = new URL(request.url).searchParams.get("url") ?? "";
    // Only ever Steam's own image hosts, so this is not a way to make Polaris
    // fetch whatever somebody puts in a query string.
    if (!isWorkshopImage(url)) return new NextResponse(null, { status: 400 });

    try {
        const answer = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!answer.ok) return new NextResponse(null, { status: 404 });
        const bytes = await answer.arrayBuffer();
        if (bytes.byteLength > MAX_BYTES) return new NextResponse(null, { status: 404 });
        // What it is, read from the bytes rather than from what Steam called it.
        // Most Workshop previews come back as `application/octet-stream` because
        // that is how they were stored, and a proxy that trusted the header
        // dropped nearly all of them - which is what an operator sees as a mods
        // screen with no pictures on it. Reading the bytes is also stricter: a
        // file that is not an image is refused whatever the header claimed.
        const type = imageTypeOfBytes(new Uint8Array(bytes.slice(0, 16)));
        if (!type) return new NextResponse(null, { status: 404 });
        return new NextResponse(bytes, {
            headers: {
                "Content-Type": type,
                "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "X-Content-Type-Options": "nosniff"
            }
        });
    } catch {
        return new NextResponse(null, { status: 404 });
    }
}
