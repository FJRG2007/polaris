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
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";
import { markDomains } from "@/lib/mailbox/sender-domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A mark is a small file. Anything bigger is not one, and fetching it would be
 *  somebody using this to move bytes through the server. */
const MAX_BYTES = 512 * 1024;

/** How long an answer is kept here. A brand's mark does not change often, and a
 *  site that has none should not be asked again on every scroll. */
const REMEMBER_MS = 6 * 60 * 60 * 1000;

const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i;

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
 * The site's own mark, at the two addresses every site puts one.
 *
 * Asked of the sending host first and then of the domain it belongs to, because
 * almost nobody sends from the site their logo is on: Apple's receipts come from
 * `email.apple.com`, which serves nothing at all, and asking only that is why a
 * mailbox full of household names showed initials. Which domain a host belongs
 * to is `markDomains`, along with the reason it never walks further than one
 * step.
 *
 * Nothing clever beyond that: a site that hides its mark behind a parsed page is
 * a site whose senders get initials, which is a fine outcome.
 */
async function fetchMark(domain: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    for (const host of markDomains(domain)) {
        for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
            const target = safeUrl(`https://${host}${path}`);
            if (!target) continue;
            const response = await follow(target, "image/*").catch(() => null);
            if (!response || response.status !== 200) continue;
            const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
            if (!IMAGE_TYPES.test(type)) continue;
            const bytes = await readCapped(response, MAX_BYTES);
            if (bytes && bytes.length > 0) return { bytes, type };
        }
    }
    return null;
}

function picture(bytes: Uint8Array, type: string): Response {
    return new Response(new Uint8Array(bytes), {
        headers: {
            // A mark served as markup on this origin is script waiting to happen,
            // so an SVG is handed over as bytes for an <img> and nothing else.
            "content-type": type === "image/svg+xml" ? "application/octet-stream" : type,
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
