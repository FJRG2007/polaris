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
 * actually is in markup it already holds, for a message that belongs to whoever
 * the address was signed for. Somebody who guesses an address can, at most, make
 * Polaris fetch a picture out of their own mail.
 *
 * **The caller is the signature, not the cookie.** A message is drawn in a
 * sandboxed frame with no same-origin privileges, and such a frame is a
 * different site as far as cookies go - Polaris' session cookie is not sent with
 * anything it asks for. Guarding this on the session meant every picture in
 * every message answered 401, which is what "the images do not load" was. The
 * pass in the address carries who it was for instead.
 *
 * The fetch itself goes through the same guard every person-supplied address in
 * Polaris goes through: public addresses only, redirects followed by hand and
 * re-checked at each hop, a timeout, and a byte ceiling.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";
import { IMAGE_CACHE_SECONDS, readImagePass } from "@/lib/mailbox/image-token";

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
    { params }: { params: Promise<{ messageId: string; index: string; token: string }> }
): Promise<Response> {
    const { messageId, index, token } = await params;

    const at = Number.parseInt(index, 10);
    if (!Number.isInteger(at) || at < 0) return new Response("Not found", { status: 404 });

    const pass = readImagePass(token, messageId, at);
    if (!pass) return new Response("Not found", { status: 404 });

    // Narrowed by the reader the pass was signed for, inside the query. The same
    // answer for "not there" and "not yours", so an id cannot be probed.
    const message = await prisma.mailMessage.findFirst({
        where: { id: messageId, account: { userId: pass.userId } },
        select: { bodyHtml: true }
    });
    if (!message?.bodyHtml) return new Response("Not found", { status: 404 });

    // The address this number stood for, found by running the very function that
    // numbered it over the very markup it numbered. Deriving it any other way is
    // what put the wrong picture in messages that used one twice: two walks over
    // the same HTML agreed until they did not, and nothing said so.
    let wanted = "";
    core.proxyRemoteContent(message.bodyHtml, (position, url) => {
        if (position === at) wanted = url;
        return "";
    });
    if (!wanted) return new Response("Not found", { status: 404 });

    const target = safeUrl(wanted);
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
            // came out of is not a proxy's business, and never longer than the
            // pass that fetched it is good for.
            "cache-control": `private, max-age=${IMAGE_CACHE_SECONDS}`
        }
    });
}
