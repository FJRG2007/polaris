/**
 * A web image's thumbnail or its full bytes, by the id a search handed out.
 *
 * The id names a result, never an address: where the bytes are is what the
 * search itself was told, so this cannot be pointed anywhere else. They are
 * fetched through the guarded fetch, checked by their first bytes to be a PNG,
 * JPEG, WebP or GIF, and served from this origin as an inert download, so the
 * host they came from never learns who looked at them.
 */

import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { webImageBytes } from "@/lib/web-images/search";
import { webImageFileSchema } from "@/lib/web-images/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A grid of twenty a page, scrolled through quickly. */
const THUMB_LIMIT = 600;
/** Images actually chosen. */
const FULL_LIMIT = 30;
const WINDOW_MS = 60_000;

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const words = await readerWords("api");

    const params = new URL(request.url).searchParams;
    const parsed = webImageFileSchema.safeParse({
        id: params.get("id") ?? "",
        size: params.get("size") ?? undefined
    });
    if (!parsed.success) return Response.json({ error: words("errors.invalidRequest") }, { status: 400 });
    const { id, size } = parsed.data;

    const throttle = await rateLimit(
        `web-image-${size}:${user.id}`,
        size === "thumb" ? THUMB_LIMIT : FULL_LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok) {
        return Response.json(
            { error: words("errors.tooManyRequests") },
            { status: 429, headers: { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) } }
        );
    }

    const image = await webImageBytes(id, size);
    if (!image) return Response.json({ error: words("errors.fetchFailed") }, { status: 404 });

    return new Response(Buffer.from(image.bytes), {
        headers: {
            "content-type": image.type,
            "content-length": String(image.bytes.byteLength),
            "x-polaris-filename": encodeURIComponent(image.name),
            "access-control-expose-headers": "x-polaris-filename",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": size === "thumb" ? "private, max-age=86400" : "private, no-store"
        }
    });
}
