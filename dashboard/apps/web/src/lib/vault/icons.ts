/**
 * The little icon beside a saved login.
 *
 * Bitwarden clients ask their server for these, and that is the reason to serve
 * them: an icon request per saved site is a list of the sites somebody has
 * accounts on, and it should not leave this deployment for a third party to
 * collect.
 *
 * It is also the only place in the vault that makes an outbound request on
 * behalf of a caller, which makes it the one place a server-side request forgery
 * could start. So the guard is the point of the module, not a detail of it: the
 * name has to look like a public domain, every address it resolves to has to be
 * public, and the fetch is capped in time and size. Redirects are not followed,
 * because a redirect is how a name that passed the check becomes one that would
 * not have.
 */

import { Agent, fetch } from "undici";
import { lookup } from "node:dns/promises";
import { isPrivateIp } from "@polaris/core";
import type { LookupFunction } from "node:net";

/** How long to wait for a site that is not answering. */
const TIMEOUT_MS = 4000;

/** The biggest icon that will be kept. Anything larger is not a favicon. */
const MAX_BYTES = 256 * 1024;

/** How long a fetched icon is held in memory. */
const CACHE_MS = 24 * 60 * 60 * 1000;

/** How many icons are held at once, so a long vault cannot grow this forever. */
const CACHE_MAX = 500;

/** An icon, as callers read it. */
export interface SiteIcon {
    bytes: Buffer;
    contentType: string;
}

interface CachedIcon extends SiteIcon {
    at: number;
}

/** An address a name already resolved to, kept so the fetch goes to that host
 *  rather than to whatever a second lookup would return. */
interface PinnedHost {
    address: string;
    family: number;
}

/** A small in-process cache. Losing it on restart costs one fetch per site. */
const cache = new Map<string, CachedIcon | null>();

/** Whether a name is one worth trying at all. */
function plausibleDomain(domain: string): boolean {
    if (domain.length === 0 || domain.length > 253) return false;
    // A bare address is never a public site's name here, and allowing one is the
    // simplest way to be pointed at a private host.
    if (/^[\d.]+$/.test(domain) || domain.includes(":")) return false;
    if (!/^[a-z0-9.-]+$/i.test(domain)) return false;
    if (!domain.includes(".")) return false;
    if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
    // Names that only ever resolve inside a network.
    const lower = domain.toLowerCase();
    return !["localhost", "local", "internal", "lan", "home.arpa"].some(
        (suffix) => lower === suffix || lower.endsWith(`.${suffix}`)
    );
}

/**
 * The address to talk to, when every address this name resolves to is public.
 *
 * One of them is handed back rather than a yes: the answer that was checked and
 * the answer that is connected to have to be the same one, and two lookups a
 * moment apart are exactly what a DNS rebind needs to be two different answers.
 */
async function resolvesPublicly(domain: string): Promise<PinnedHost | null> {
    try {
        const addresses = await lookup(domain, { all: true });
        const first = addresses[0];
        if (!first || addresses.some((entry) => isPrivateIp(entry.address))) return null;
        return { address: first.address, family: first.family };
    } catch {
        return null;
    }
}

/** A resolver that always answers with the address already vetted. */
function pinnedLookup(host: PinnedHost): LookupFunction {
    return (_hostname, options, callback) => {
        // Node asks for every address when it is happy-eyeballing, and for one
        // otherwise. There is only ever the one to give.
        if (options.all) {
            callback(null, [{ address: host.address, family: host.family }]);
            return;
        }
        callback(null, host.address, host.family);
    };
}

/** Fetch one candidate URL, refusing anything that is not a small image. */
async function tryFetch(url: string, host: PinnedHost): Promise<CachedIcon | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    // The name still goes out in SNI and in the Host header - only where the
    // socket lands is pinned - so a certificate is still checked against the
    // site that was asked for.
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(host) } });
    try {
        const response = await fetch(url, {
            dispatcher,
            signal: controller.signal,
            // Not followed: the check above was about the name that was asked
            // for, and a redirect is how that name becomes another one.
            redirect: "manual",
            headers: { accept: "image/*" }
        });
        if (!response.ok || !response.body) return null;
        const type = response.headers.get("content-type") ?? "";
        if (!type.startsWith("image/")) return null;
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > MAX_BYTES) return null;

        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
        return { bytes, contentType: type.split(";")[0] ?? "image/png", at: Date.now() };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        await dispatcher.destroy().catch(() => undefined);
    }
}

/**
 * What the cache already holds for a domain.
 *
 * `undefined` means nothing usable, and answering will cost a lookup and an
 * outbound request. That is the difference the endpoint's rate limit is drawn
 * on - serving one that is already here costs nothing and should not be charged
 * for - so it is asked separately rather than folded into the fetch.
 */
export function cachedSiteIcon(domain: string): SiteIcon | null | undefined {
    const cached = cache.get(domain.trim().toLowerCase());
    if (cached === undefined || cached === null) return cached;
    return Date.now() - cached.at < CACHE_MS ? cached : undefined;
}

/**
 * The icon for a domain, or null.
 *
 * Null is cached too: a site with no favicon is the common case, and without it
 * every vault open would re-try every one of them.
 */
export async function fetchSiteIcon(domain: string): Promise<SiteIcon | null> {
    const key = domain.trim().toLowerCase();
    const cached = cachedSiteIcon(key);
    if (cached !== undefined) return cached;
    if (!plausibleDomain(key)) return null;
    const host = await resolvesPublicly(key);
    if (!host) return null;

    const icon =
        (await tryFetch(`https://${key}/favicon.ico`, host)) ??
        (await tryFetch(`https://${key}/apple-touch-icon.png`, host));

    if (cache.size >= CACHE_MAX) {
        // Oldest first, which for a Map is insertion order - close enough for a
        // cache whose entries are all worth about the same.
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, icon);
    return icon;
}
