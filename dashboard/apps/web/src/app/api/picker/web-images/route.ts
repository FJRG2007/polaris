/**
 * The picker's "Search the web" tab: one page of openly licensed images.
 *
 * Asked of this server, never of the image index from the browser, so the
 * reader's address stays here; `lib/web-images/search.ts` says which sources
 * answer and why no key is needed.
 */

import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { webImageSearchSchema } from "@/lib/web-images/shape";
import { searchWebImages, WebImagesUnavailable } from "@/lib/web-images/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Searches one account may run a minute: a debounced field typed into
 *  steadily, with pages scrolled through. */
const SEARCH_LIMIT = 60;
const SEARCH_WINDOW_MS = 60_000;

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const words = await readerWords("api");

    const params = new URL(request.url).searchParams;
    const parsed = webImageSearchSchema.safeParse({
        q: params.get("q") ?? "",
        page: params.get("page") ?? undefined,
        safe: params.get("safe") ?? undefined
    });
    if (!parsed.success) return Response.json({ error: words("errors.invalidSearch") }, { status: 400 });

    const throttle = await rateLimit(`web-images:${user.id}`, SEARCH_LIMIT, SEARCH_WINDOW_MS);
    if (!throttle.ok) {
        return Response.json(
            { error: words("errors.tooManyRequests") },
            { status: 429, headers: { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) } }
        );
    }

    try {
        const { q, page, safe } = parsed.data;
        const found = await searchWebImages(q, page, safe);
        return Response.json(found, { headers: { "cache-control": "private, max-age=60" } });
    } catch (caught) {
        const status = caught instanceof WebImagesUnavailable ? 503 : 500;
        return Response.json({ error: words("errors.searchFailed") }, { status });
    }
}
