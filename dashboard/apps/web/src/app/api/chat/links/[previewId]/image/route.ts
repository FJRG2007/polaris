/**
 * The picture on a link card, fetched back through Polaris.
 *
 * Pointing the browser at the site's own address would tell whoever runs that
 * page who read the message and when, every time somebody scrolls past it. The
 * same reason a GIF is stored rather than linked.
 *
 * It is addressed by the preview row, never by a URL in the request. A route
 * that took the address would be an open fetch proxy with a Polaris login in
 * front of it, which is exactly what the preview module exists not to be - here
 * the only addresses reachable are ones Polaris itself extracted from a page it
 * had already decided it was allowed to fetch.
 *
 * Signing in is still required: the card belongs to a message in a conversation,
 * and an image route open to the world would be a small hole in a closed app.
 */

import { requirePermission } from "@/lib/session";
import { previewImage } from "@/lib/chat/link-preview";

export const runtime = "nodejs";

/** How long a browser may keep it. A preview picture does not change under its
 *  address in any way that matters, and re-fetching it on every render would put
 *  the load back on the site the card is about. */
const CACHE_SECONDS = 24 * 60 * 60;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ previewId: string }> }
): Promise<Response> {
    await requirePermission("chat.use");
    const { previewId } = await params;

    const image = await previewImage(previewId).catch(() => null);
    // A site that has moved its picture, or one that is simply down. The card
    // draws without it rather than with a broken frame.
    if (!image) return new Response(null, { status: 404 });

    return new Response(Buffer.from(image.bytes), {
        headers: {
            "content-type": image.contentType,
            "cache-control": `private, max-age=${CACHE_SECONDS}`,
            // Nothing here is a document, whatever the bytes turn out to be.
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox"
        }
    });
}
