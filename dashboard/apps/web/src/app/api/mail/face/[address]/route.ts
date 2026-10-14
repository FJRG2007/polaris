/**
 * A face for a sender.
 *
 * A column of names is harder to scan than a column of faces, and almost every
 * message in a mailbox is from an organisation that has a mark - which is what
 * makes this worth having at all.
 *
 * Four answers, in this order:
 *
 * - **Somebody on this Polaris.** An address that provably belongs to an account
 *   here - any of their addresses, see `face-owner` - gets the picture they
 *   chose, the same one their messages carry in Chat. Only when the reader may
 *   see it under that person's privacy settings; otherwise the address is
 *   answered exactly as if nobody here owned it.
 * - **Their Gravatar**, when the instance uses Gravatar at all. Fetched by
 *   Polaris, never by the browser, and remembered for a day either way.
 * - **The sender's own site.** Fetched by Polaris, never by the browser, so what
 *   the site learns is that a server asked. The one already in front of the
 *   reader is a page they are not visiting.
 * - **Nothing.** The list draws initials, which is better than a broken picture
 *   and better than a grey circle pretending to be one.
 *
 * A person's picture is served here rather than through a redirect to their
 * avatar, which saves the browser a second request per face, and is kept by the
 * browser only on condition: it asks again on every use and is answered with a
 * 304, so a picture somebody has since hidden is not shown from a cache.
 *
 * Marks are cached in this process by domain rather than by address, because a
 * hundred messages from one shop are one question, and in the browser for an
 * hour so scrolling a mailbox does not re-ask - and so an address that turns out
 * to be a colleague's shows their face the same day. The cache is bounded
 * (`bounded-map.ts`), so a server running for months does not hold one entry per
 * domain it has ever seen. A reader who scrolls past more new domains than a
 * mailbox reasonably has in ten minutes gets initials instead of a hunt, rather
 * than this process fetching a mark per row for somebody else's page.
 */

import { apiPermission } from "@/lib/api-session";
import { setBounded } from "@/lib/bounded-map";
import { rateLimit } from "@/lib/rate-limit-service";
import { resolveAvatar } from "@/lib/avatar-service";
import { addressGravatar, visibleOwner } from "@/lib/mailbox/face-owner";
import { markDomains } from "@/lib/mailbox/sender-domain";
import { iconLinks, MAX_HTML_BYTES } from "@/lib/mailbox/site-icon";
import { follow, readAtMost, readCapped, safeUrl } from "@/lib/safe-fetch";
import { createGate, createSharedFlight, deadline } from "@/lib/concurrency-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A mark is a small file. Anything bigger is not one, and fetching it would be
 *  somebody using this to move bytes through the server. */
const MAX_BYTES = 512 * 1024;

/** How long the browser keeps a mark, a Gravatar or "nothing" before asking
 *  again. Private: what an address shows depends on who is asking. */
const MARK_CACHE = "private, max-age=3600";

/** A person's picture is kept but checked on every use, so a privacy change or
 *  a new photo reaches the reader at once. The check is a 304 and no bytes. */
const PERSON_CACHE = "private, no-cache";

/** How long a cold Gravatar lookup may hold the face before the mark hunt is
 *  tried instead. Gravatar's own ceiling is four seconds; a queue in front of it
 *  should not add to that. */
const GRAVATAR_WAIT_MS = 5_000;

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
const BUDGET_MS = 12_000;

/**
 * How long any one host may cost.
 *
 * The budget above is not enough on its own, and the reason is the whole shape
 * of this search: the host a message was SENT from is asked first, and it is the
 * one least likely to answer - almost nobody serves a website from
 * `email.clicktopay.visa.com`. A host like that does not refuse the connection,
 * it drops it, so each of its two paths costs the full five-second ceiling and
 * the two together spent the entire budget. `visa.com`, which serves the logo in
 * two hundred milliseconds, was never asked at all.
 *
 * So each host gets a share instead. A dead one costs its share and the next one
 * is still asked, which is the difference between a household name showing its
 * logo and showing two letters.
 */
const PER_HOST_MS = 4_000;

/**
 * How many domains are hunted at once, across every reader.
 *
 * A mailbox opened cold asks for a mark per row, all at the same moment, and a
 * hunt is several outside requests that can each take seconds. Unbounded, one
 * screenful of senders was dozens of those running together - see
 * `LOOKUP_SLOTS` in `safe-fetch.ts` for what that did to every other page. The
 * rest wait here and are answered in turn; the list draws initials meanwhile.
 */
const hunts = createGate(4);

/** A hundred messages from one shop arriving together are one hunt, not a
 *  hundred: the cache below only helps once the first has finished. */
const sameDomain = createSharedFlight<Found | null>();

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
/** How much of that is kept. Every sender's domain is a key, spam included, and a
 *  site decides how large its mark is; past this the oldest answers go. */
const FACE_LIMITS = {
    maxEntries: 2_000,
    maxBytes: 32 * 1024 * 1024,
    sizeOf: (held: Remembered) => held.bytes?.byteLength ?? 0
};
/** Sites one reader may send this server to look through, per window. A mailbox
 *  scrolled end to end is a few hundred domains, and each one is remembered. */
const HUNTS_PER_WINDOW = 300;
const HUNT_WINDOW_MS = 10 * 60 * 1000;

function remembered(): Map<string, Remembered> {
    const held = globalThis as { [FACES]?: Map<string, Remembered> };
    held[FACES] ??= new Map();
    return held[FACES];
}

export async function GET(
    request: Request,
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

    // Somebody with an account here, when this reader may see them. Their own
    // picture, not a guess at their employer's logo.
    const owner = await visibleOwner(wanted, { id: user.id, isAdmin: Boolean(user.isAdmin) });
    if (owner) {
        const { picture } = await resolveAvatar(owner);
        if (picture) {
            if (request.headers.get("if-none-match") === picture.etag) {
                return new Response(null, {
                    status: 304,
                    headers: { etag: picture.etag, "cache-control": PERSON_CACHE }
                });
            }
            // A photo whose storage is not answering this second falls through
            // to what a stranger at the address would get, rather than a hole.
            const bytes = await picture.load();
            if (bytes) return image(bytes, picture.mime, PERSON_CACHE, picture.etag);
        }
    }

    // Their Gravatar, asked by this server. Skipped when it is not answering in
    // time: the site's mark is still worth a try.
    const wait = deadline(
        GRAVATAR_WAIT_MS,
        `${wanted} waited too long for Gravatar`,
        request.signal
    );
    const gravatar = await addressGravatar(wanted, wait.signal).finally(() => wait.clear());
    if (gravatar?.image) {
        const { bytes, mime, etag } = gravatar.image;
        if (request.headers.get("if-none-match") === etag) {
            return new Response(null, {
                status: 304,
                headers: { etag, "cache-control": MARK_CACHE }
            });
        }
        return image(bytes, mime, MARK_CACHE, etag);
    }

    const held = remembered().get(domain);
    if (held && Date.now() - held.at < REMEMBER_MS) {
        return held.bytes ? image(held.bytes, held.type, MARK_CACHE) : gone();
    }

    if (!(await rateLimit(`mail-face-hunt:${user.id}`, HUNTS_PER_WINDOW, HUNT_WINDOW_MS)).ok)
        return busy();
    const hunt = deadline(BUDGET_MS, `${domain} waited too long for a hunt`, request.signal);
    try {
        const found = await sameDomain(
            domain,
            (abandoned) =>
                hunts.run(async () => {
                    const mark = await fetchMark(domain);
                    setBounded(
                        remembered(),
                        domain,
                        { at: Date.now(), bytes: mark?.bytes ?? null, type: mark?.type ?? "" },
                        FACE_LIMITS
                    );
                    return mark;
                }, abandoned),
            hunt.signal
        );
        return found ? image(found.bytes, found.type, MARK_CACHE) : gone();
    } catch {
        return busy();
    } finally {
        hunt.clear();
    }
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
        // Each host's own ceiling as well as the shared one, so a host that
        // silently drops connections cannot spend what the next one needed.
        const mine = Math.min(deadline, Date.now() + PER_HOST_MS);
        for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
            if (Date.now() > mine) break;
            const found = await pictureAt(`https://${host}${path}`);
            if (found) return found;
        }
        if (Date.now() > deadline) return null;
    }

    for (const host of hosts) {
        if (Date.now() > deadline) return null;
        const found = await declaredMark(host, Math.min(deadline, Date.now() + PER_HOST_MS));
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
function image(bytes: Uint8Array, type: string, cache: string, etag?: string): Response {
    const headers: Record<string, string> = {
        "content-type": type,
        "content-length": String(bytes.length),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": cache
    };
    if (etag) headers.etag = etag;
    return new Response(new Uint8Array(bytes), { headers });
}

/** No picture. The list draws initials, which is what an `<img>` that fails
 *  tells it to do. */
function gone(): Response {
    return new Response(null, {
        status: 404,
        headers: { "cache-control": MARK_CACHE }
    });
}

/** No picture yet. Initials as well, but not remembered by the browser: the
 *  mark may well be found on the next visit. */
function busy(): Response {
    return new Response(null, {
        status: 503,
        headers: { "cache-control": "no-store" }
    });
}
