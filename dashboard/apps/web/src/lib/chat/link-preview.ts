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
import { oembedFor } from "./embeds";
import * as core from "@polaris/core";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";

/** How much of a page is read before deciding. The metadata is in the head; a
 *  site that has not said what it is by here is not going to. */
const MAX_BYTES = 512 * 1024;

/** How long a look is trusted before the page is asked again. */
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** What a message's link resolved to, as the card draws it. */
export interface LinkPreviewView {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly description: string;
    readonly siteName: string;
    /** Whether there is a picture to ask Polaris for. The address itself never
     *  leaves the server. */
    readonly hasImage: boolean;
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
    /** The card, when it did. */
    readonly view: LinkPreviewView | null;
}

/** What is already known for these addresses. Never fetches: a read path that
 *  could fetch is a read path that hangs on somebody else's server. */
export async function knownPreviews(
    urls: readonly string[]
): Promise<Map<string, KnownPreview>> {
    const wanted = [...new Set(urls)];
    if (wanted.length === 0) return new Map();

    const rows = await prisma.linkPreview.findMany({
        where: { url: { in: wanted } },
        select: {
            id: true,
            ok: true,
            url: true,
            title: true,
            description: true,
            siteName: true,
            imageUrl: true
        }
    });
    return new Map(
        rows.map((row) => [
            row.url,
            {
                ok: row.ok,
                view: row.ok
                    ? {
                          id: row.id,
                          url: row.url,
                          title: row.title,
                          description: row.description,
                          siteName: row.siteName,
                          hasImage: row.imageUrl !== null
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
 * once a week instead of on every render.
 */
export async function unfurl(address: string): Promise<void> {
    const url = safeUrl(address);
    if (!url) return;

    const existing = await prisma.linkPreview.findUnique({
        where: { url: url.href },
        select: { fetchedAt: true }
    });
    if (existing && Date.now() - existing.fetchedAt.getTime() < FRESH_MS) return;

    const found = await describe(url);
    const data = {
        title: found?.title ?? "",
        description: found?.description ?? "",
        siteName: found?.siteName ?? "",
        imageUrl: found?.imageUrl ?? null,
        // A page with no title and no description is a page there is nothing to
        // say about, and a card saying nothing is worse than no card.
        ok: Boolean(found && (found.title || found.description)),
        fetchedAt: new Date()
    };

    await prisma.linkPreview.upsert({
        where: { url: url.href },
        create: { url: url.href, ...data },
        update: data
    });
}

/** The picture for one preview, fetched back through Polaris. Null when there is
 *  none, or when it has stopped being reachable. */
export async function previewImage(
    previewId: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const row = await prisma.linkPreview.findUnique({
        where: { id: previewId },
        select: { imageUrl: true }
    });
    // Addressed by the row rather than by a URL in the request. A route that
    // took the address would be an open fetch proxy, which is the thing this
    // whole module exists not to be.
    if (!row?.imageUrl) return null;

    const url = safeUrl(row.imageUrl);
    if (!url) return null;

    const response = await follow(url);
    if (!response?.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!contentType.startsWith("image/")) return null;

    const bytes = await readCapped(response, MAX_BYTES);
    return bytes ? { bytes, contentType } : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Described {
    title: string;
    description: string;
    siteName: string;
    imageUrl: string | null;
}

/** What one page says about itself, or what its site says about it when the page
 *  itself says nothing. */
async function describe(url: URL): Promise<Described | null> {
    const fromPage = await describePage(url);
    if (fromPage && (fromPage.title || fromPage.description)) return fromPage;
    return (await describeByOembed(url)) ?? fromPage;
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

    const response = await follow(asked, "application/json");
    if (!response?.ok) return null;
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return null;

    const bytes = await readCapped(response, MAX_BYTES);
    if (!bytes) return null;

    let payload: { title?: unknown; author_name?: unknown; provider_name?: unknown; thumbnail_url?: unknown };
    try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    } catch {
        return null;
    }

    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const title = text(payload.title).slice(0, 200);
    if (!title) return null;

    return {
        title,
        // The uploader, which is what a video card is actually asked: who made
        // this. There is no description in an oEmbed answer.
        description: text(payload.author_name).slice(0, 400),
        siteName: (text(payload.provider_name) || url.hostname).slice(0, 100),
        imageUrl: absolute(text(payload.thumbnail_url), url)
    };
}

/** What one page says about itself. */
async function describePage(url: URL): Promise<Described | null> {
    const response = await follow(url);
    if (!response?.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    // Only a page describes itself. A PDF or a zip has nothing to unfurl, and
    // reading one to find that out is bytes spent to learn nothing.
    if (!contentType.includes("html")) return null;

    const bytes = await readCapped(response, MAX_BYTES);
    if (!bytes) return null;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const image = meta(html, "og:image") ?? meta(html, "twitter:image");
    return {
        title: (meta(html, "og:title") ?? titleTag(html) ?? "").slice(0, 200),
        description: (
            meta(html, "og:description") ??
            meta(html, "description") ??
            meta(html, "twitter:description") ??
            ""
        ).slice(0, 400),
        siteName: (meta(html, "og:site_name") ?? url.hostname).slice(0, 100),
        imageUrl: image ? absolute(image, url) : null
    };
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
    const pattern = new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`,
        "i"
    );
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
