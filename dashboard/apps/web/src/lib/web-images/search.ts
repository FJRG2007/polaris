/**
 * Images from the open web, for the picker's "Search the web" tab.
 *
 * Keyless on purpose: a feature that needs an account somewhere is switched
 * off on every install that never made one. Two sources, both free to ask
 * without a key and both licensed for reuse:
 *
 * - Openverse (https://api.openverse.org/v1/), the WordPress project's index of
 *   openly licensed media. Anonymous callers get 20 results a page, 240 per
 *   query, and 100 requests a minute / 1000 a day per address - the limits its
 *   own `x-ratelimit-*-anon_*` headers announce. Its `mature=false` is the
 *   SafeSearch here.
 * - Wikimedia Commons (https://commons.wikimedia.org/w/api.php), asked only when
 *   Openverse cannot answer and SafeSearch is off: Commons has no content
 *   filter, so with SafeSearch on it is not asked at all. Its etiquette asks for
 *   a descriptive User-Agent and requests in series, which one search per
 *   question at a time is.
 *
 * Every address - the API, the thumbnail, the image - is reached through the
 * guarded fetch (`lib/safe-fetch.ts`), so nothing an upstream answer names can
 * steer this server onto its own network. The browser never asks those hosts
 * for anything: it asks this server, which fetches once and answers everybody.
 *
 * Results are kept in memory and shared by every account, coalesced so a
 * thousand identical searches are one upstream request, and served stale while
 * they refresh: losing them costs a request, which is why there is no table.
 */

import { coalescer } from "@/lib/coalesce";
import { setBounded } from "@/lib/bounded-map";
import { sniffImageMime } from "@/lib/avatar-service";
import { configuredRequest, fetchImage } from "@/lib/safe-fetch";
import {
    WEB_IMAGE_MAX_PAGE,
    WEB_IMAGE_PAGE_SIZE,
    type WebImage,
    type WebImageCredit,
    type WebImagePage
} from "@/lib/web-images/shape";

/** Wikimedia asks for a User-Agent that says what is calling. No contact
 *  address: an install's operator is nobody's to publish. */
const USER_AGENT = "Polaris/1.0 (self-hosted workspace; image picker)";

/** The types a picked image may be. Anything else is refused by its bytes. */
export const WEB_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const MAX_THUMB_BYTES = 1024 * 1024;
export const MAX_FULL_BYTES = 15 * 1024 * 1024;

/** A search answer is fresh this long, and served stale (while it refreshes)
 *  for this long after. */
const FRESH_MS = 10 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 500;
/** Where each result's bytes are: every id a search handed out, so the image
 *  route never takes an address from the browser. */
const MAX_LOCATED = 5000;
const MAX_THUMBS = 300;

const SUPPORTED = /\.(?:png|jpe?g|gif|webp)$/i;

interface Located {
    readonly image: WebImage;
    readonly thumb: string;
    readonly full: string;
}

export class WebImagesUnavailable extends Error {
    constructor() {
        super("Image search is unavailable.");
        this.name = "WebImagesUnavailable";
    }
}

const answers = new Map<string, { at: number; page: WebImagePage }>();
const located = new Map<string, Located>();
const searches = coalescer<WebImagePage>();
const thumbs = coalescer<FetchedImage>({ ttlMs: 30 * 60 * 1000, maxKeys: MAX_THUMBS });
const fulls = coalescer<FetchedImage>();

/**
 * One page of results. Fresh from memory, stale from memory while a refresh
 * runs behind it, or asked upstream once however many readers asked at once.
 */
export async function searchWebImages(query: string, page: number, safe: boolean): Promise<WebImagePage> {
    const key = `${safe ? 1 : 0}:${page}:${query}`;
    const known = answers.get(key);
    const age = known ? Date.now() - known.at : Number.POSITIVE_INFINITY;
    if (known && age < FRESH_MS) return known.page;
    const refresh = searches.run(key, async () => {
        const found = await askUpstream(query, page, safe);
        setBounded(answers, key, { at: Date.now(), page: found }, { maxEntries: MAX_PAGES });
        return found;
    });
    if (known && age < STALE_MS) {
        refresh.catch(() => undefined);
        return known.page;
    }
    return refresh;
}

async function askUpstream(query: string, page: number, safe: boolean): Promise<WebImagePage> {
    try {
        return await fromOpenverse(query, page, safe);
    } catch {
        if (safe) throw new WebImagesUnavailable();
        try {
            return await fromCommons(query, page);
        } catch {
            throw new WebImagesUnavailable();
        }
    }
}

async function getJson(address: string): Promise<unknown> {
    const response = await configuredRequest(
        address,
        { headers: { accept: "application/json", "user-agent": USER_AGENT }, timeoutMs: 8000 },
        { allowPrivate: false }
    );
    if (!response.ok) throw new Error(`upstream answered ${response.status}`);
    return response.json();
}

const text = (value: unknown, max = 300): string =>
    typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";

const https = (value: unknown): string => {
    const raw = text(value, 2000);
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
    return /^https:\/\/[^\s]+$/i.test(absolute) ? absolute : "";
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function remember(entry: Located): WebImage {
    setBounded(located, entry.image.id, entry, { maxEntries: MAX_LOCATED });
    return entry.image;
}

// ---- Openverse -------------------------------------------------------------

const OPENVERSE = "https://api.openverse.org/v1/images/";

interface OpenverseImage {
    id?: unknown;
    title?: unknown;
    url?: unknown;
    thumbnail?: unknown;
    creator?: unknown;
    creator_url?: unknown;
    license?: unknown;
    license_version?: unknown;
    license_url?: unknown;
    foreign_landing_url?: unknown;
    filetype?: unknown;
    mature?: unknown;
    width?: unknown;
    height?: unknown;
}

/** "by-sa" and "2.0" as people write it: "CC BY-SA 2.0"; the two public-domain
 *  marks by their names. */
function licenseName(license: unknown, version: unknown): string {
    const code = text(license, 40).toLowerCase();
    if (code === "cc0") return "CC0 1.0";
    if (code === "pdm") return "Public Domain Mark";
    const named = `CC ${code.toUpperCase()} ${text(version, 10)}`.trim();
    return code ? named : "";
}

export function fromOpenverseImage(raw: OpenverseImage, safe: boolean): Located | null {
    const id = text(raw.id, 40);
    const full = https(raw.url);
    const thumb = https(raw.thumbnail);
    const filetype = text(raw.filetype, 10).toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(id) || !full || !thumb) return null;
    if (filetype ? !SUPPORTED.test(`.${filetype}`) : /\.(?:svg|tiff?|bmp)$/i.test(full.split("?")[0]!)) return null;
    if (safe && raw.mature === true) return null;
    const title = text(raw.title, 200);
    const credit: WebImageCredit = {
        provider: "openverse",
        title,
        creator: text(raw.creator, 200),
        creatorUrl: https(raw.creator_url),
        license: licenseName(raw.license, raw.license_version),
        licenseUrl: https(raw.license_url),
        sourceUrl: https(raw.foreign_landing_url)
    };
    return { image: { id: `ov:${id}`, title, width: count(raw.width), height: count(raw.height), credit }, thumb, full };
}

async function fromOpenverse(query: string, page: number, safe: boolean): Promise<WebImagePage> {
    const url = new URL(OPENVERSE);
    url.searchParams.set("q", query);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(WEB_IMAGE_PAGE_SIZE));
    url.searchParams.set("mature", safe ? "false" : "true");
    const body = (await getJson(url.href)) as { results?: OpenverseImage[]; page_count?: unknown };
    if (!Array.isArray(body.results)) throw new Error("not an answer");
    const results = body.results.flatMap((raw) => {
        const one = fromOpenverseImage(raw, safe);
        return one ? [remember(one)] : [];
    });
    return { results, more: page < Math.min(count(body.page_count), WEB_IMAGE_MAX_PAGE) };
}

// ---- Wikimedia Commons -----------------------------------------------------

const COMMONS = "https://commons.wikimedia.org/w/api.php";

interface CommonsPage {
    pageid?: unknown;
    title?: unknown;
    imageinfo?: {
        url?: unknown;
        thumburl?: unknown;
        mime?: unknown;
        size?: unknown;
        width?: unknown;
        height?: unknown;
        descriptionurl?: unknown;
        extmetadata?: Record<string, { value?: unknown } | undefined>;
    }[];
}

function commonsUrl(params: Record<string, string>): string {
    const url = new URL(COMMONS);
    const base = {
        action: "query",
        format: "json",
        formatversion: "2",
        prop: "imageinfo",
        iiprop: "url|mime|size|extmetadata",
        iiurlwidth: "320",
        iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|ObjectName"
    };
    for (const [name, value] of Object.entries({ ...base, ...params })) url.searchParams.set(name, value);
    return url.href;
}

export function fromCommonsPage(raw: CommonsPage): Located | null {
    const info = raw.imageinfo?.[0];
    const pageid = count(raw.pageid);
    if (!info || pageid <= 0) return null;
    const full = https(info.url);
    const thumb = https(info.thumburl);
    const mime = text(info.mime, 40);
    if (!full || !thumb || !WEB_IMAGE_TYPES.includes(mime) || count(info.size) > MAX_FULL_BYTES) return null;
    const meta = info.extmetadata ?? {};
    const title = text(meta.ObjectName?.value, 200) || text(raw.title, 200).replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
    const credit: WebImageCredit = {
        provider: "wikimedia",
        title,
        creator: text(meta.Artist?.value, 200),
        creatorUrl: "",
        license: text(meta.LicenseShortName?.value, 60),
        licenseUrl: https(meta.LicenseUrl?.value),
        sourceUrl: https(info.descriptionurl)
    };
    return {
        image: { id: `wc:${pageid}`, title, width: count(info.width), height: count(info.height), credit },
        thumb,
        full
    };
}

async function fromCommons(query: string, page: number): Promise<WebImagePage> {
    const body = (await getJson(
        commonsUrl({
            generator: "search",
            gsrnamespace: "6",
            gsrsearch: `${query} filetype:bitmap`,
            gsrlimit: String(WEB_IMAGE_PAGE_SIZE),
            gsroffset: String((page - 1) * WEB_IMAGE_PAGE_SIZE)
        })
    )) as { query?: { pages?: CommonsPage[] }; continue?: unknown };
    const pages = [...(body.query?.pages ?? [])].sort(
        (a, b) => count((a as { index?: unknown }).index) - count((b as { index?: unknown }).index)
    );
    const results = pages.flatMap((raw) => {
        const one = fromCommonsPage(raw);
        return one ? [remember(one)] : [];
    });
    return { results, more: Boolean(body.continue) && page < WEB_IMAGE_MAX_PAGE };
}

// ---- The bytes -------------------------------------------------------------

/** Where an id's bytes are: from a search this process answered, else asked of
 *  the provider by that id (after a restart, or on another process). */
async function locate(id: string): Promise<Located | null> {
    const known = located.get(id);
    if (known) return known;
    if (id.startsWith("ov:")) {
        const raw = (await getJson(`${OPENVERSE}${id.slice(3)}/`).catch(() => null)) as OpenverseImage | null;
        const one = raw ? fromOpenverseImage(raw, false) : null;
        if (one) remember(one);
        return one;
    }
    const body = (await getJson(commonsUrl({ pageids: id.slice(3) })).catch(() => null)) as {
        query?: { pages?: CommonsPage[] };
    } | null;
    const one = body?.query?.pages?.[0] ? fromCommonsPage(body.query.pages[0]) : null;
    if (one) remember(one);
    return one;
}

export interface FetchedImage {
    readonly name: string;
    readonly type: string;
    readonly bytes: Uint8Array;
    readonly credit: WebImageCredit;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif"
};

/** A file name from the title: what Drive and every other destination will
 *  call it, so it reads as the image rather than as an id. */
function fileName(title: string, type: string): string {
    const stem = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${stem || "image"}.${EXTENSIONS[type] ?? "img"}`;
}

/**
 * An image's thumbnail or the image itself, by the id a search handed out.
 * Null when it is gone, too big, or not one of the four types a picker takes -
 * decided by its bytes, never by what the other end called it.
 */
export async function webImageBytes(id: string, size: "thumb" | "full"): Promise<FetchedImage | null> {
    const flight = size === "thumb" ? thumbs : fulls;
    try {
        return await flight.run(`${size}:${id}`, async () => {
            const where = await locate(id);
            if (!where) throw new Error("unknown id");
            const got = await fetchImage(
                size === "thumb" ? where.thumb : where.full,
                size === "thumb" ? MAX_THUMB_BYTES : MAX_FULL_BYTES
            );
            const type = got ? sniffImageMime(got.bytes) : null;
            if (!got || !type || !WEB_IMAGE_TYPES.includes(type)) throw new Error("not an image");
            return { name: fileName(where.image.title, type), type, bytes: got.bytes, credit: where.image.credit };
        });
    } catch {
        return null;
    }
}

/** For tests: start from nothing. */
export function forgetWebImages(): void {
    answers.clear();
    located.clear();
    searches.forget();
    thumbs.forget();
    fulls.forget();
}
