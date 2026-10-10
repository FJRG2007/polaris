/**
 * What the Sounds tab's two upload routes share: the same-origin check an
 * action makes, a refusal as JSON, and the body read up to one sound's limit.
 *
 * Server-only.
 */

import { bounded } from "./mod-items-service";
import { MAX_SOUND_BYTES } from "./sounds";

/** The same check an action makes before it runs. */
export function sameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    const where = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
        return new URL(origin).host === where;
    } catch {
        return false;
    }
}

export function refuse(status: number, error: string): Response {
    return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/** The body, read up to the limit: null past it, "empty" for nothing. The
 *  length the sender claims is only a first answer; the stream is what counts. */
export async function readUpload(request: Request): Promise<Uint8Array | null | "empty"> {
    const claimed = Number(request.headers.get("content-length") ?? "0");
    if (claimed > MAX_SOUND_BYTES) return null;
    if (!request.body) return "empty";
    const bytes = await bounded(request.body, MAX_SOUND_BYTES);
    if (bytes === null) return null;
    return bytes.length === 0 ? "empty" : bytes;
}
