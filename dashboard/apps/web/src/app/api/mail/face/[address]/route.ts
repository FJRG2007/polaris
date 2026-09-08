/**
 * A face for a sender.
 *
 * A column of names is harder to scan than a column of faces, and almost every
 * message in a mailbox is from an organisation that has a mark - which is what
 * makes this worth having at all.
 *
 * Three answers, in this order:
 *
 * - **Somebody on this Polaris.** A colleague writing from an address that
 *   belongs to an account here gets the picture they chose, the same one their
 *   messages carry in Chat.
 * - **The sender's own site.** Fetched by Polaris, never by the browser, so what
 *   the site learns is that a server asked. The one already in front of the
 *   reader is a page they are not visiting.
 * - **Nothing.** The list draws initials, which is better than a broken picture
 *   and better than a grey circle pretending to be one.
 *
 * Cached in this process by domain rather than by address, because a hundred
 * messages from one shop are one question, and cached in the browser for a day
 * so scrolling a mailbox does not re-ask.
 */

import { prisma } from "@polaris/db";
import { apiPermission } from "@/lib/api-session";
import { markDomains } from "@/lib/mailbox/sender-domain";
import { iconLinks, MAX_HTML_BYTES } from "@/lib/mailbox/site-icon";
import { follow, readAtMost, readCapped, safeUrl } from "@/lib/safe-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A mark is a small file. Anything bigger is not one, and fetching it would be
 *  somebody using this to move bytes through the server. */
const MAX_BYTES = 512 * 1024;

/** How long an answer is kept here. A brand's mark does not change often, and a
 *  site that has none should not be asked again on every scroll. */
const REMEMBER_MS = 6 * 60 * 60 * 1000;

const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;

/**
 * How long the whole hunt may take.
 *
 * Up to three hosts are asked for two paths each and then for their front page,
 * and every one of those has its own five-second ceiling. Without a budget over
 * the lot, one domain that accepts connections and never answers holds a request
 * open for the sum of them - so the search gives up here and the reader gets
 * initials, which is what they would have got anyway.
 */
const BUDGET_MS = 10_000;

/** A mark, as it will be handed to the browser. */
interface Found {
    readonly bytes: Uint8Array;
    readonly type: string;
}

interface Remembered {
    readonly at: number;
    readonly bytes: Uint8Array | null;
    readonly type: string;
}

/** Held on `globalThis` for the same reason the live bus is: a dev server
 *  re-evaluates the module and a fresh map would forget every answer. */
const FACES = Symbol.for("polaris.mail.faces");

function remembered(): Map<string, Remembered> {
    const held = globalThis as { [FACES]?: Map<string, Remembered> };
    held[FACES] ??= new Map();
    return held[FACES];
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ address: string }> }
): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const { address } = await params;
    const wanted = decodeURIComponent(address).trim().toLowerCase();
    const at = wanted.lastIndexOf("@");
    if (at < 1) return gone();
    const domain = wanted.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
    if (!domain.includes(".")) return gone();

    // Somebody with an account here. Their own picture, not a guess at their
    // employer's logo.
    const person = await prisma.user.findFirst({
        where: { email: wanted },
        select: { id: true }
    });
    if (person) {
        return Response.redirect(new URL(`/api/avatar/${person.id}`, "http://polaris.invalid"), 307);
    }

    const held = remembered().get(domain);
    if (held && Date.now() - held.at < REMEMBER_MS) {
        return held.bytes ? picture(held.bytes, held.type) : gone();
    }

    const found = await fetchMark(domain);
    remembered().set(domain, { at: Date.now(), bytes: found?.bytes ?? null, type: found?.type ?? "" });
    return found ? picture(found.bytes, found.type) : gone();
}

/**
 * The site's own mark.
 *
 * Asked of the sending host first and then of the domain it belongs to and that
 * domain's `www`, because almost nobody sends from the site their logo is on:
 * Apple's receipts come from `email.apple.com`, which serves nothing at all, and
 * asking only that is why a mailbox full of household names showed initials.
 * Which hosts a sender belongs to is `markDomains`, along with the reason it
 * never walks further.
 *
 * Two passes over those hosts, because they cost differently. The well-known
 * paths first, which is one request and answers for most senders. Then the front
 * page, read for the icon it declares in its head - a site built as a single page
 * application commonly serves its own 404 at both well-known paths and names its
 * logo in the markup instead, which is npm, and which used to be initials.
 */
async function fetchMark(domain: string): Promise<Found | null> {
    const deadline = Date.now() + BUDGET_MS;
    const hosts = markDomains(domain);

    for (const host of hosts) {
        for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
            if (Date.now() > deadline) return null;
            const found = await pictureAt(`https://${host}${path}`);
            if (found) return found;
        }
    }

    for (const host of hosts) {
        if (Date.now() > deadline) return null;
        const found = await declaredMark(host, deadline);
        if (found) return found;
    }
    return null;
}

/** Whatever is at one address, if it is a picture and small enough to be a
 *  mark. */
async function pictureAt(address: string): Promise<Found | null> {
    const target = safeUrl(address);
    if (!target) return null;
    const response = await follow(target, "image/*").catch(() => null);
    if (!response || response.status !== 200) return null;
    const type = contentType(response);
    // A site with no 404 answers a missing favicon with its home page, so this
    // is the check that keeps a web page out of the picture column.
    if (!IMAGE_TYPES.test(type)) return null;
    const bytes = await readCapped(response, MAX_BYTES);
    return bytes && bytes.length > 0 ? { bytes, type } : null;
}

/** The mark a site names in its own head, for the sites that serve none at the
 *  addresses above. */
async function declaredMark(host: string, deadline: number): Promise<Found | null> {
    const target = safeUrl(`https://${host}/`);
    if (!target) return null;
    const response = await follow(target).catch(() => null);
    if (!response || response.status !== 200) return null;
    if (!/^(?:text\/html|application\/xhtml)/i.test(contentType(response))) return null;

    const bytes = await readAtMost(response, MAX_HTML_BYTES);
    if (!bytes) return null;
    // Cut off mid-character rather than refused, so a long head is still read.
    // The icon is named in an attribute, and an attribute is ASCII either way.
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    // Against where the page ended up, not where it was asked for: a bare domain
    // that redirects to its `www` publishes relative hrefs that only resolve
    // against the destination.
    for (const link of iconLinks(html, response.url || target.href)) {
        if (Date.now() > deadline) return null;
        const found = await pictureAt(link.href);
        if (found) return found;
    }
    return null;
}

function contentType(response: { headers: Headers }): string {
    return (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
}

/**
 * The mark, handed to the browser.
 *
 * An SVG is served as one, which needs saying because the obvious defensive
 * move - hand it over as opaque bytes - does not work: `nosniff` is set, so a
 * picture typed `application/octet-stream` is a picture the `<img>` refuses, and
 * every sender whose only mark is a vector one silently fell back to initials.
 *
 * It is safe as an image, twice over. An SVG inside an `<img>` is drawn in the
 * spec's secure static mode, where script and external references do not run at
 * all; and somebody who opens this address in a tab of its own lands in a
 * document that `sandbox` has put in an opaque origin and `default-src 'none'`
 * has left nothing to execute with.
 */
function picture(bytes: Uint8Array, type: string): Response {
    return new Response(new Uint8Array(bytes), {
        headers: {
            "content-type": type,
            "content-length": String(bytes.length),
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, max-age=86400"
        }
    });
}

/** No picture. The list draws initials, which is what an `<img>` that fails
 *  tells it to do. */
function gone(): Response {
    return new Response(null, { status: 404, headers: { "cache-control": "private, max-age=3600" } });
}
