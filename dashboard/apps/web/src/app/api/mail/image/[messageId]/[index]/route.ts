/**
 * A picture a message wants to show, fetched by Polaris instead of by the reader.
 *
 * This is what lets mail show its images without telling the sender anything. A
 * tracking pixel loaded directly hands over the reader's address, their browser,
 * and the moment they opened the message. Loaded through here it gets a request
 * from this server and nothing else - no address, no user agent worth having, no
 * correlation with a person.
 *
 * **It is not an open proxy, and that is the point of the address.** No URL is
 * accepted from anybody. The route names a message and a position, both of which
 * are meaningless without the message; the server looks up what that position
 * actually is in markup it already holds, for a message it has already proved
 * belongs to the caller. Somebody who guesses an address can, at most, make
 * Polaris fetch a picture out of their own mail.
 *
 * The fetch itself goes through the same guard every person-supplied address in
 * Polaris goes through: public addresses only, redirects followed by hand and
 * re-checked at each hop, a timeout, and a byte ceiling.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { apiPermission } from "@/lib/api-session";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most one picture in a message may be. Generous for a header image, far
 *  below anything that would be worth using this to move. */
const MAX_BYTES = 8 * 1024 * 1024;

/** What may come back. A message's "picture" that answers with a document is
 *  not a picture, and serving it as one is how a proxy becomes a way to host
 *  somebody else's content on this origin. */
const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ messageId: string; index: string }> }
): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;
    const { messageId, index } = await params;

    const at = Number.parseInt(index, 10);
    if (!Number.isInteger(at) || at < 0) return new Response("Not found", { status: 404 });

    // Narrowed by the caller inside the query. The same answer for "not there"
    // and "not yours", so an id cannot be probed.
    const message = await prisma.mailMessage.findFirst({
        where: { id: messageId, account: { userId: user.id } },
        select: { bodyHtml: true }
    });
    if (!message?.bodyHtml) return new Response("Not found", { status: 404 });

    // The addresses in the order `proxyRemoteContent` numbered them, off markup
    // this server already holds. Nothing here came from the request.
    const wanted = core.remoteResourcesIn(message.bodyHtml)[at];
    if (!wanted) return new Response("Not found", { status: 404 });

    const target = safeUrl(wanted.url);
    if (!target) return new Response("Not found", { status: 404 });

    const response = await follow(target, "image/*");
    if (!response || response.status !== 200) return new Response("", { status: 204 });

    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!IMAGE_TYPES.test(type)) return new Response("", { status: 204 });

    const bytes = await readCapped(response, MAX_BYTES);
    if (!bytes) return new Response("", { status: 204 });

    return new Response(new Uint8Array(bytes), {
        headers: {
            // SVG is markup, and markup served as itself on this origin is
            // script waiting to happen. It is handed over as bytes for an
            // <img> to draw and nothing else.
            "content-type": type === "image/svg+xml" ? "application/octet-stream" : type,
            "content-length": String(bytes.length),
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            // A message's pictures do not change. Private, because whose mail it
            // came out of is not a proxy's business.
            "cache-control": "private, max-age=86400"
        }
    });
}
