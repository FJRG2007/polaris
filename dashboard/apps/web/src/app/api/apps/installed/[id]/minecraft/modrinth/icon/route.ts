import { NextResponse } from "next/server";
import { requireGameServer } from "@/lib/apps/install-access";
import { isModrinthIcon } from "@/lib/apps/minecraft/modrinth";

export const runtime = "nodejs";

/**
 * A project's icon, fetched by Polaris rather than by the browser.
 *
 * The rest of this feature is proxied for a reason - the dashboard should not
 * make the operator's machine talk to a third party to render a page - and an
 * `<img src>` pointing straight at a CDN is exactly that: every mods screen would
 * announce to Modrinth who is looking at it and from where. So the image comes
 * through here, from an address this side has already checked belongs to them.
 *
 * Cached hard. A project's icon changes about never, and the alternative is a
 * request per row per visit through a server that has other work to do.
 */
const CACHE_SECONDS = 24 * 3600;
const TIMEOUT_MS = 8000;
/** Enough for any icon Modrinth serves, and small enough that this can never be
 *  used to pull something large through the dashboard. */
const MAX_BYTES = 512 * 1024;

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    await requireGameServer("games.read", id);

    const url = new URL(request.url).searchParams.get("url") ?? "";
    // Only ever Modrinth's own CDN, so this is not a way to make Polaris fetch
    // whatever somebody puts in a query string.
    if (!isModrinthIcon(url)) return new NextResponse(null, { status: 400 });

    try {
        const answer = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const type = (answer.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
        if (!answer.ok || !ALLOWED_TYPES.includes(type)) return new NextResponse(null, { status: 404 });
        const bytes = await answer.arrayBuffer();
        if (bytes.byteLength > MAX_BYTES) return new NextResponse(null, { status: 404 });
        return new NextResponse(bytes, {
            headers: {
                "Content-Type": type,
                "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
                // It is somebody else's image file, rendered inside a dashboard
                // somebody is logged into. An SVG is a document that can carry
                // script, so nothing here is allowed to be treated as one.
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "X-Content-Type-Options": "nosniff"
            }
        });
    } catch {
        return new NextResponse(null, { status: 404 });
    }
}
