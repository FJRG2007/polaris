/**
 * What a link posted in a conversation turns out to be.
 *
 * **This module fetches a URL somebody typed**, which is the most dangerous
 * thing a server can be asked to do - so it does not do it itself. Every request
 * goes through `safe-fetch`, which refuses private addresses, re-checks every
 * redirect hop, and caps how long and how much. That is where the reasoning
 * behind those rules is written down.
 *
 * The picture is not handed to the browser as the site's own address. Reading a
 * message would then tell whoever runs that page who read it and when, which is
 * the same reason a GIF is stored rather than linked. It is fetched back through
 * Polaris instead.
 */

import { prisma } from "@polaris/db";
import { embedFor, isShareLink, landingOf, oembedFor } from "./embeds";
import * as core from "@polaris/core";
import { follow, readAtMost, readCapped, safeUrl, whereLeads } from "@/lib/safe-fetch";
import {
    readSteamAnswer,
    steamAppOf,
    steamDetailsUrl,
    storedSteamDetails,
    STEAM_FRESH_MS,
    type SteamDetails
} from "./steam";

/**
 * How much of a page is read before deciding.
 *
 * Generous, and measured rather than guessed: YouTube puts its `og:` tags 690 KB
 * into a watch page, behind the script that draws the player. At half a megabyte
 * the read stopped just short of them, which is why a video came back with a
 * thumbnail from its site's oEmbed and nothing else. What is read is truncated
 * rather than refused - a page too long to finish is still a page whose head we
 * have.
 */
const MAX_PAGE_BYTES = 1024 * 1024;

/** How much of a small document - an oEmbed answer, a manifest - is read. These
 *  are kilobytes; anything at this size is not one. */
const MAX_BYTES = 512 * 1024;

/** How much of a picture is read. A video thumbnail at full width is a couple of
 *  hundred kilobytes, and the ceiling above would have refused it - which is a
 *  card with a play button and no picture behind it. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** How long a look is trusted before the page is asked again. */
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a look that came back with nothing is trusted for.
 *
 *  Much shorter, because "nothing" is as often about us as about the page: a
 *  site that was slow, a network that was down, or a way of asking that has
 *  since been improved. Trusting a failure for a week means one bad afternoon
 *  keeps a link blank until the following Tuesday. */
const RETRY_MS = 60 * 60 * 1000;

/** What a message's link resolved to, as the card draws it. */
export interface LinkPreviewView {
    readonly id: string;
    readonly url: string;
    /** Where a share-button short link led (`vm.tiktok.com/...` to the video's
     *  own page), without the sharer's query, or null for a link that was not one
     *  or could not be followed. The player is built from this when it is set;
     *  the card still opens the address that was posted. */
    readonly target: string | null;
    readonly title: string;
    readonly description: string;
    /** Who made the thing, when the site says: the channel behind a video, the
     *  byline on an article. Separate from the description because it is a name
     *  and reads as one - "YouTube / BaityLive" over the title. */
    readonly author: string;
    readonly siteName: string;
    /** The colour the site says it is, as `#rrggbb`, or null when it does not
     *  say or says something unusable. */
    readonly accent: string | null;
    /** Whether there is a picture to ask Polaris for. The address itself never
     *  leaves the server. */
    readonly hasImage: boolean;
    /** What a Steam store link adds to the card - the price, the release, the
     *  systems - or null for every other link. */
    readonly steam: SteamDetails | null;
}

/**
 * What is known about one address.
 *
 * The distinction between "looked and there was nothing" and "never looked" is
 * the whole point of this shape. Without it the screen cannot tell a link with
 * no card from a link nobody has got to yet, so it either asks forever or never
 * asks at all - and never asking is why cards did not appear.
 */
export interface KnownPreview {
    /** Whether the look produced something worth drawing. */
    readonly ok: boolean;
    /** Whether what is stored is old enough to be worth asking again. The card
     *  that is already there keeps being drawn meanwhile - a refresh is not a
     *  reason to blank a message. */
    readonly askAgain: boolean;
    /** The card, when it did. */
    readonly view: LinkPreviewView | null;
}

/** What is already known for these addresses. Never fetches: a read path that
 *  could fetch is a read path that hangs on somebody else's server. */
export async function knownPreviews(urls: readonly string[]): Promise<Map<string, KnownPreview>> {
    const wanted = [...new Set(urls)];
    if (wanted.length === 0) return new Map();

    const rows = await prisma.linkPreview.findMany({
        where: { url: { in: wanted } },
        select: {
            id: true,
            ok: true,
            url: true,
            target: true,
            title: true,
            author: true,
            accent: true,
            siteName: true,
            imageUrl: true,
            fetchedAt: true,
            description: true,
            details: true
        }
    });
    const now = Date.now();
    return new Map(
        rows.map((row) => [
            row.url,
            {
                ok: row.ok,
                askAgain: now - row.fetchedAt.getTime() > trustedFor(row),
                view: row.ok
                    ? {
                          id: row.id,
                          url: row.url,
                          target: row.target,
                          title: row.title,
                          author: row.author,
                          accent: row.accent,
                          siteName: row.siteName,
                          hasImage: row.imageUrl !== null,
                          description: row.description,
                          steam: steamAppOf(row.url) ? storedSteamDetails(row.details) : null
                      }
                    : null
            }
        ])
    );
}

/**
 * Look a link up, unless it was looked up recently.
 *
 * Called after a message lands and never awaited by the send: an unfurl is worth
 * a card under a message and is not worth the message being slower to appear.
 * Every failure is recorded rather than thrown, so a dead link is asked about
 * once an hour instead of on every render.
 */
export async function unfurl(
    address: string,
    /** Look now, however recently it was looked at - for a card whose picture
     *  has stopped answering. The caller bounds how often. */
    options: { force?: boolean } = {}
): Promise<void> {
    const url = safeUrl(address);
    if (!url) return;

    const existing = await prisma.linkPreview.findUnique({
        where: { url: url.href },
        select: { ok: true, url: true, target: true, fetchedAt: true }
    });
    const age = existing ? Date.now() - existing.fetchedAt.getTime() : Infinity;
    if (existing && !options.force && age < trustedFor(existing)) return;

    // A share link is followed first, and everything after is about where it
    // led: the site's own description of a TikTok is only to be had for the
    // video's address, never for `vm.tiktok.com/<code>`. One that could not be
    // followed is not walked a second time to describe it - it is a failure,
    // asked about again in an hour like any other.
    const share = isShareLink(url.href);
    const target = share ? await landing(url) : null;
    const steamApp = steamAppOf(url.href);
    const found = steamApp
        ? await describeSteam(steamApp)
        : share && !target
          ? null
          : await describe(target ? new URL(target) : url);
    const data = {
        target,
        // Only a Steam card has any, kept as JSON text and read back through
        // a schema - see `storedSteamDetails`.
        details: found?.details ? JSON.stringify(found.details) : null,
        title: found?.title ?? "",
        author: found?.author ?? "",
        accent: found?.accent ?? null,
        siteName: found?.siteName ?? "",
        imageUrl: found?.imageUrl ?? null,
        description: found?.description ?? "",
        // A page with no title and no description is a page there is nothing to
        // say about, and a card saying nothing is worse than no card. A video
        // whose site names only who posted it - a TikTok with no caption - is
        // still a video somebody posted, and its card says whose it is.
        ok: Boolean(found && (found.title || found.description || found.author)),
        fetchedAt: new Date()
    };

    if (existing?.ok && !data.ok) {
        await prisma.linkPreview.updateMany({
            where: { url: url.href },
            data: { fetchedAt: data.fetchedAt }
        });
        return;
    }

    await prisma.linkPreview.upsert({
        where: { url: url.href },
        create: { url: url.href, ...data },
        update: data
    });
}

/** The picture for one preview, fetched back through Polaris. Null when there is
 *  none, or when it has stopped being reachable.
 *
 *  A picture that stopped answering is most often a signed address that
 *  expired - TikTok's covers, two days after they were handed out. The page is
 *  then read again in the same request, at most once an hour per card, and its
 *  freshly signed picture is the answer: the picture fails on screen once, at
 *  an address that never changes, so a refresh left for the next visit is a
 *  card with no picture on this one. */
export async function previewImage(
    previewId: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const row = await prisma.linkPreview.findUnique({
        where: { id: previewId },
        select: { imageUrl: true, url: true, fetchedAt: true }
    });
    // Addressed by the row rather than by a URL in the request. A route that
    // took the address would be an open fetch proxy, which is the thing this
    // whole module exists not to be.
    if (!row?.imageUrl) return null;

    const first = await fetchPicture(row.imageUrl);
    if (first) return first;

    if (row.url && (await claimLook(previewId))) {
        await unfurl(row.url, { force: true }).catch(() => undefined);
        const again = await prisma.linkPreview.findUnique({
            where: { id: previewId },
            select: { imageUrl: true }
        });
        if (again?.imageUrl && again.imageUrl !== row.imageUrl) {
            const fresh = await fetchPicture(again.imageUrl);
            if (fresh) return fresh;
        }
    }
    await lookAgainSoon(previewId);
    return null;
}

async function fetchPicture(
    address: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const url = safeUrl(address);
    if (!url) return null;
    const response = await follow(url, "image/*");
    const contentType = (response?.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const bytes =
        response?.ok && contentType.startsWith("image/")
            ? await readCapped(response, MAX_IMAGE_BYTES)
            : null;
    return bytes ? { bytes, contentType } : null;
}

/** Take this hour's look at a card, or learn that another request already has:
 *  the condition is part of the write, so of several picture requests arriving
 *  together only one reads the page again. */
async function claimLook(previewId: string): Promise<boolean> {
    const now = Date.now();
    const claimed = await prisma.linkPreview
        .updateMany({
            where: { id: previewId, fetchedAt: { lt: new Date(now - RETRY_MS) } },
            data: { fetchedAt: new Date(now) }
        })
        .catch(() => ({ count: 0 }));
    return claimed.count === 1;
}

/**
 * Mark a card whose picture has stopped answering as worth looking at again.
 *
 * Some sites sign their picture addresses with an expiry - TikTok's covers stop
 * answering about two days after they were handed out, well inside the week a
 * card is trusted for. The next look gets a freshly signed address, so the card
 * gets its picture back instead of a broken one until the week is up. At most
 * once an hour per card: a row looked at within the hour is left alone, so a
 * picture that is gone for good costs one look an hour, not one per render.
 */
async function lookAgainSoon(previewId: string): Promise<void> {
    const now = Date.now();
    await prisma.linkPreview
        .updateMany({
            where: { id: previewId, fetchedAt: { lt: new Date(now - RETRY_MS) } },
            data: { fetchedAt: new Date(now - FRESH_MS - 1) }
        })
        .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * How long one stored look is trusted for.
 *
 * A share link that was never followed - stored before Polaris followed them, or
 * when following it failed - is trusted only as long as a failure, so a
 * `vm.tiktok.com` link posted last week becomes a player within the hour instead
 * of staying a card until its week is up. Bounded either way: one look an hour
 * at most, never one per render.
 */
function trustedFor(row: { ok: boolean; url: string; target: string | null }): number {
    if (!row.ok || (row.target === null && isShareLink(row.url))) return RETRY_MS;
    // A price is only as good as the last sale it saw.
    if (steamAppOf(row.url)) return STEAM_FRESH_MS;
    return FRESH_MS;
}

/**
 * Where a share link leads, through the same checked hops as every fetch here.
 * The walk stops at the first address that is not itself a share link, before
 * asking it anything, and what is kept is that address without its query.
 */
async function landing(url: URL): Promise<string | null> {
    const reached = await whereLeads(url, (next) => !isShareLink(next.href));
    if (!reached || isShareLink(reached.href)) return null;
    const kept = landingOf(reached.href);
    return kept && kept.length <= core.MAX_LINK_LENGTH ? kept : null;
}

interface Described {
    title: string;
    author: string;
    accent: string | null;
    siteName: string;
    imageUrl: string | null;
    description: string;
    /** Whether the title and the site name are only the page's fallbacks - the
     *  `<title>` tag and the hostname - rather than what it declares about the
     *  thing (`og:title`, `og:site_name`). */
    guessed?: { title: boolean; siteName: boolean };
    /** What a Steam store link adds - see `describeSteam`. */
    details?: SteamDetails;
}

/**
 * A Steam store link, asked of Steam's storefront rather than of the page - see
 * `steam.ts` for why. Priced in the country that matches the instance's
 * currency and written in its language, read from the operator's display
 * defaults; an instance that never chose is EUR and English.
 */
async function describeSteam(appId: string): Promise<Described | null> {
    const { currency, language } = await instanceDisplay();
    const asked = safeUrl(steamDetailsUrl(appId, currency, language));
    if (!asked) return null;
    const payload = await readJson(asked, "application/json");
    const found = readSteamAnswer(appId, payload);
    if (!found) return null;
    return {
        title: found.title,
        author: found.author,
        accent: null,
        siteName: "Steam",
        imageUrl: found.imageUrl,
        description: found.description,
        details: found.details
    };
}

/** The instance's currency and language, or the defaults when it has none or
 *  they cannot be read - a card in euros is better than no card. */
async function instanceDisplay(): Promise<{ currency: string; language: string }> {
    try {
        const { getSetting } = await import("@/lib/setting-store");
        const chosen = core.parseDisplayPreferences(await getSetting("display.defaults"));
        return {
            currency: chosen.currency ?? core.DISPLAY_DEFAULTS.currency,
            language: chosen.language ?? core.DISPLAY_DEFAULTS.language
        };
    } catch {
        return {
            currency: core.DISPLAY_DEFAULTS.currency,
            language: core.DISPLAY_DEFAULTS.language
        };
    }
}

/**
 * What one page says about itself, and what its site says about it.
 *
 * Both are asked at once, for the two different things they know. The page
 * carries the description and the picture; the site's own oEmbed carries the one
 * thing a page never states plainly, which is who made the thing - the channel
 * behind a video is the second line of the card, and reading it off the HTML
 * would mean guessing at a different shape of markup per site.
 *
 * The page wins wherever both answer, since it is the thing that was linked -
 * except where all the page has is a fallback. TikTok hands every video page to
 * a fetch titled "TikTok - Make Your Day", with no `og:` tags, while its oEmbed
 * names the video; the `<title>` tag and the hostname only stand in when the
 * site says nothing.
 */
async function describe(url: URL): Promise<Described | null> {
    const [fromPage, fromSite] = await Promise.all([describePage(url), describeByOembed(url)]);
    if (!fromPage && !fromSite) return null;
    const declared = (value: string | undefined, guessed: boolean | undefined) =>
        guessed ? "" : value || "";
    return {
        // A site that answered about a post with no caption has said the title
        // is empty; the page's generic `<title>` is not the post's either.
        title:
            declared(fromPage?.title, fromPage?.guessed?.title) ||
            fromSite?.title ||
            (fromSite ? "" : fromPage?.title) ||
            "",
        author: fromSite?.author || fromPage?.author || "",
        accent: fromPage?.accent ?? null,
        siteName:
            declared(fromPage?.siteName, fromPage?.guessed?.siteName) ||
            fromSite?.siteName ||
            fromPage?.siteName ||
            "",
        imageUrl: fromPage?.imageUrl ?? fromSite?.imageUrl ?? null,
        description: fromPage?.description || ""
    };
}

/**
 * What a site says about one of its own links, over oEmbed.
 *
 * The reason this exists: a YouTube link is the single most posted link there
 * is, and asking youtube.com for the page gets a consent wall with no metadata
 * in it - so the message that mattered most got no card at all. oEmbed answers
 * the same question in one small JSON document, with no key and no account.
 *
 * Only the fixed endpoints in `oembedFor` are ever asked, and the answer is
 * treated as text: a title, a name and a picture address, all of them checked
 * before anything is done with them.
 */
async function describeByOembed(url: URL): Promise<Described | null> {
    const endpoint = oembedFor(url.href);
    if (!endpoint) return null;

    const asked = safeUrl(endpoint);
    if (!asked) return null;

    const payload = await readJson(asked, "application/json");
    if (!payload) return null;

    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const title = text(payload.title).slice(0, 200);
    const author = text(payload.author_name).slice(0, 100);
    // An answer with no title is usually an answer about nothing. The exception
    // is a playable link whose post simply has no caption: TikTok answers those
    // with the account and the picture, which is the whole card Discord draws.
    if (!title && !(author && embedFor(url.href))) return null;

    return {
        title,
        // The uploader, which is what a video card is actually asked: who made
        // this. There is no description in an oEmbed answer.
        author,
        accent: null,
        siteName: (text(payload.provider_name) || url.hostname).slice(0, 100),
        imageUrl: absolute(text(payload.thumbnail_url), url),
        description: ""
    };
}

/** One small JSON document from an address already checked, or null when what
 *  came back was not one. */
async function readJson(url: URL, accept: string): Promise<Record<string, unknown> | null> {
    const response = await follow(url, accept);
    if (!response?.ok) return null;
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return null;

    const bytes = await readCapped(response, MAX_BYTES);
    if (!bytes) return null;

    try {
        const parsed: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: false }).decode(bytes)
        );
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** What one page says about itself. */
async function describePage(url: URL): Promise<Described | null> {
    const response = await follow(url);
    if (!response?.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    // Only a page describes itself. A PDF or a zip has nothing to unfurl, and
    // reading one to find that out is bytes spent to learn nothing.
    if (!contentType.includes("html")) return null;

    const bytes = await readAtMost(response, MAX_PAGE_BYTES);
    if (!bytes) return null;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const image = meta(html, "og:image") ?? meta(html, "twitter:image");
    const ogTitle = meta(html, "og:title");
    const ogSiteName = meta(html, "og:site_name");
    return {
        title: (ogTitle ?? titleTag(html) ?? "").slice(0, 200),
        author: (meta(html, "article:author") ?? meta(html, "author") ?? "").slice(0, 100),
        accent: await accentOf(html, url),
        siteName: (ogSiteName ?? url.hostname).slice(0, 100),
        guessed: { title: ogTitle === null, siteName: ogSiteName === null },
        imageUrl: image ? absolute(image, url) : null,
        description: (
            meta(html, "og:description") ??
            meta(html, "description") ??
            meta(html, "twitter:description") ??
            ""
        ).slice(0, 400)
    };
}

/**
 * The colour a site says it is.
 *
 * The web app manifest first. `theme-color` in the page is the tint for the
 * browser's chrome around the page *as it is drawn now* - YouTube's says white,
 * because the page is white - while the manifest is where a site writes down
 * what it looks like as a thing, and YouTube's says red. The meta tag is the
 * fallback for the many sites that publish no manifest.
 *
 * Only `#rgb` and `#rrggbb` are taken. `rgba(255, 255, 255, .98)` and the named
 * colours are perfectly valid CSS and would go straight into a style attribute,
 * so the answer is narrowed to the one shape that cannot be anything else.
 */
async function accentOf(html: string, url: URL): Promise<string | null> {
    const link = /<link[^>]+rel\s*=\s*["'][^"']*\bmanifest\b[^"']*["'][^>]*>/i.exec(html)?.[0];
    const href = link ? /href\s*=\s*["']([^"']+)["']/i.exec(link)?.[1] : null;
    const address = href ? absolute(decode(href.trim()), url) : null;
    const asked = address ? safeUrl(address) : null;
    if (asked) {
        const manifest = await readJson(asked, "application/manifest+json,application/json");
        const declared = hexColour(manifest?.theme_color);
        if (declared) return declared;
    }
    return hexColour(meta(html, "theme-color"));
}

/** A colour written the one way it is allowed to be written here. */
function hexColour(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[0];
    return hex ? hex.toLowerCase() : null;
}

/**
 * One meta tag's content.
 *
 * A regex rather than a parser, deliberately: this reads four known tags out of
 * the head of a document from an untrusted source, and nothing here is rendered
 * as markup - what comes out is text and is escaped by whatever draws it. A DOM
 * parser would be a dependency and an attack surface for no gain.
 */
function meta(html: string, name: string): string | null {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, "i");
    const tag = pattern.exec(html)?.[0];
    if (!tag) return null;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    return content ? decode(content.trim()) || null : null;
}

function titleTag(html: string): string | null {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    return title ? decode(title.trim()) || null : null;
}

/** The handful of entities a title actually arrives with. Everything else is
 *  left alone: this is going into a text node either way. */
function decode(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&#x27;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ");
}

function absolute(address: string, base: URL): string | null {
    // An empty one would resolve to the page itself, which is how a card ends up
    // with an HTML document where its picture should be.
    if (!address) return null;
    try {
        const resolved = new URL(address, base);
        return resolved.protocol === "http:" || resolved.protocol === "https:"
            ? resolved.href.slice(0, core.MAX_LINK_LENGTH)
            : null;
    } catch {
        return null;
    }
}
