/**
 * A picture somebody wrote into a message, a task or a note, fetched through
 * Polaris.
 *
 * Drawing the address as written would send every reader's own address, and
 * the moment they read it, to whoever runs that site - the oldest way to learn
 * where somebody is from a chat. Fetched here, the site sees Polaris and nobody
 * else.
 *
 * Unlike the link-card picture this takes the address in the request, because
 * the text is the only record of it. What keeps it from being an open proxy:
 * a signed-in caller only, a per-account budget, the vetted fetch that refuses
 * private and internal addresses (`safe-fetch.ts`), an answer only for a
 * picture under the size cap, and never SVG, which is a document and not a
 * picture. The response is sandboxed so whatever the bytes are, nothing runs.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { fetchImage } from "@/lib/safe-fetch";
import { rateLimit } from "@/lib/rate-limit-service";

export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_SECONDS = 24 * 60 * 60;
/** Enough for a long thread full of pictures, not enough to use as a crawler. */
const BUDGET = 240;
const WINDOW_MS = 10 * 60 * 1000;

const query = z.object({
    url: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .url()
        .refine((value) => /^https?:\/\//i.test(value), "Only a web address")
});

export async function GET(request: Request): Promise<Response> {
    const caller = await apiUser();
    if (caller instanceof Response) return caller;

    const parsed = query.safeParse({ url: new URL(request.url).searchParams.get("url") ?? "" });
    if (!parsed.success) return new Response(null, { status: 400 });

    const budget = await rateLimit(`remote-image:${caller.id}`, BUDGET, WINDOW_MS);
    if (!budget.ok) return new Response(null, { status: 429 });

    const image = await fetchImage(parsed.data.url, MAX_BYTES).catch(() => null);
    if (!image || image.contentType === "image/svg+xml") return new Response(null, { status: 404 });

    return new Response(Buffer.from(image.bytes), {
        headers: {
            "content-type": image.contentType,
            "cache-control": `private, max-age=${CACHE_SECONDS}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox"
        }
    });
}
