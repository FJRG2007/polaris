/**
 * What a link posted in a conversation turns out to be.
 *
 * **This module fetches a URL somebody typed, which is the most dangerous thing
 * a server can be asked to do.** Polaris runs on a machine with a LAN around it
 * and, on a hosted box, a metadata service one address away. A naive unfurl is a
 * request forgery with a login page in front of it: post a link, and the server
 * fetches whatever is behind it from inside the network and hands the result
 * back. Everything below is shaped by that.
 *
 * - Only http and https, and never a hostname that resolves to anything but a
 *   public address. Every address it resolves to is checked, not just the first:
 *   a name with two A records is a name that can answer differently next time.
 * - Redirects are followed by hand, one hop at a time, re-checking the address
 *   at every hop. Following them automatically is the classic way past a check
 *   like this - the first hop is example.com and the second is 169.254.169.254.
 * - A timeout, a byte ceiling and a content-type check, so a link to a
 *   ten-gigabyte file is a failed unfurl rather than a full disk.
 *
 * The picture is not handed to the browser as the site's own address. Reading a
 * message would then tell whoever runs that page who read it and when, which is
 * the same reason a GIF is stored rather than linked. It is fetched back through
 * Polaris instead.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { lookup } from "node:dns/promises";

/** How long Polaris waits for a page before giving up on it. */
const TIMEOUT_MS = 5000;

/** How much of a page is read before deciding. The metadata is in the head; a
 *  site that has not said what it is by here is not going to. */
const MAX_BYTES = 512 * 1024;

/** How many redirects are followed. Enough for the ordinary http-to-https and a
 *  canonical host, and not enough to be walked around a network. */
const MAX_HOPS = 3;

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

/** The previews already known for these addresses. Never fetches: a read path
 *  that could fetch is a read path that hangs on somebody else's server. */
export async function knownPreviews(
    urls: readonly string[]
): Promise<Map<string, LinkPreviewView>> {
    const wanted = [...new Set(urls)];
    if (wanted.length === 0) return new Map();

    const rows = await prisma.linkPreview.findMany({
        where: { url: { in: wanted }, ok: true },
        select: {
            id: true,
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
                id: row.id,
                url: row.url,
                title: row.title,
                description: row.description,
                siteName: row.siteName,
                hasImage: row.imageUrl !== null
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

    const bytes = await readCapped(response);
    return bytes ? { bytes, contentType } : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** An address Polaris is willing to consider at all. */
function safeUrl(address: string): URL | null {
    if (address.length > core.MAX_LINK_LENGTH) return null;
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Credentials in a link being fetched by the server are somebody's password
    // being handed to whatever is on the other end.
    if (url.username || url.password) return null;
    return url;
}

/**
 * Whether a hostname points anywhere Polaris is allowed to go.
 *
 * Every resolved address has to be public, not merely the first: a name with an
 * A record for a real host and another for 127.0.0.1 would otherwise pass and
 * then connect to whichever the stack picked.
 */
async function reachable(hostname: string): Promise<boolean> {
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (core.isIpAddress(bare)) return !core.isPrivateIp(bare);

    try {
        const addresses = await lookup(bare, { all: true });
        if (addresses.length === 0) return false;
        return addresses.every((entry) => !core.isPrivateIp(entry.address));
    } catch {
        // A name that does not resolve is a name not to fetch. On a machine with
        // no resolver at all this refuses everything, which is the right way to
        // be wrong.
        return false;
    }
}

/** Fetch, following redirects by hand and re-checking every hop. */
async function follow(start: URL): Promise<Response | null> {
    let url = start;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
        if (!(await reachable(url.hostname))) return null;

        let response: Response;
        try {
            response = await fetch(url, {
                redirect: "manual",
                cache: "no-store",
                signal: AbortSignal.timeout(TIMEOUT_MS),
                headers: {
                    // Named honestly. A server that does not want to be unfurled
                    // can then say so, and the one that blocks us is not left
                    // guessing what we were.
                    "user-agent": "PolarisBot/1.0 (+link preview)",
                    accept: "text/html,application/xhtml+xml"
                }
            });
        } catch {
            return null;
        }

        if (response.status < 300 || response.status >= 400) return response;

        const next = response.headers.get("location");
        if (!next) return response;
        try {
            url = new URL(next, url);
        } catch {
            return null;
        }
        const checked = safeUrl(url.href);
        if (!checked) return null;
        url = checked;
    }
    return null;
}

/** Read at most `MAX_BYTES`, whatever the other end says it is sending. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > MAX_BYTES) return null;

    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    return bytes;
}

interface Described {
    title: string;
    description: string;
    siteName: string;
    imageUrl: string | null;
}

/** What one page says about itself. */
async function describe(url: URL): Promise<Described | null> {
    const response = await follow(url);
    if (!response?.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    // Only a page describes itself. A PDF or a zip has nothing to unfurl, and
    // reading one to find that out is bytes spent to learn nothing.
    if (!contentType.includes("html")) return null;

    const bytes = await readCapped(response);
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
    try {
        const resolved = new URL(address, base);
        return resolved.protocol === "http:" || resolved.protocol === "https:"
            ? resolved.href.slice(0, core.MAX_LINK_LENGTH)
            : null;
    } catch {
        return null;
    }
}
