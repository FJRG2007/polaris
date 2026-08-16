/**
 * GIFs and stickers, from whichever service this instance has connected.
 *
 * Server-side only, and that is the point of the module existing at all: an API
 * key is instance configuration and must not reach a browser, where it would be
 * one view-source away from being somebody else's quota.
 *
 * Two services, and the picker never knows which answered. Tenor and Giphy have
 * the same shape of catalogue and differ only in whose account the quota comes
 * out of, so this asks whichever is connected rather than making an operator
 * choose twice - once by pasting a key and again by picking a name from a list.
 * When both are connected, Giphy answers, because it is the one somebody
 * connected second.
 *
 * A key is an integration an administrator connects, like every other outside
 * service. The environment variable is still read for Tenor, so an instance that
 * set one before this screen existed keeps working.
 *
 * Nothing is stored here. What comes back is a list of addresses the picker
 * draws; choosing one is what stores something, and what it stores is an
 * ordinary attachment - see `fetchRemoteMedia`. That is deliberate: a message
 * whose GIF is a link to Tenor is a message that tells Tenor who read it and
 * when, and that stops working the day they take the file down.
 */

import { loadEnv } from "@polaris/config";
import type { IGif } from "@giphy/js-types";
import { fetchImage } from "@/lib/safe-fetch";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

/** One result, as the picker draws it. */
export interface TenorResult {
    readonly id: string;
    /** Small and animated, for the grid. */
    readonly preview: string;
    /** What is actually sent when this one is chosen. */
    readonly full: string;
    /** Tenor's own description, which is the only alt text there is. */
    readonly description: string;
    readonly width: number;
    readonly height: number;
}

export type TenorKind = "gif" | "sticker";

/** How many one page of the picker holds. Enough to fill the grid twice over
 *  without asking Tenor for a hundred. */
const PAGE = 24;

/**
 * Answers already given, so the same question is not put to a paid API twice.
 *
 * Every account on the instance shares it, which is the point: "trending" is the
 * same list for everybody, and it is what the picker asks for every single time
 * somebody opens the GIF tab. Held in memory rather than in the database because
 * losing it costs one request - the row would be a table to migrate, prune and
 * reason about for something that is stale within the hour either way.
 *
 * A search is worth keeping for less time than the featured list: somebody
 * typing is exploring, and the same word an hour later can reasonably answer
 * differently.
 */
const answers = new Map<string, { at: number; results: TenorResult[] }>();

const TRENDING_FRESH_MS = 30 * 60 * 1000;
const SEARCH_FRESH_MS = 10 * 60 * 1000;

/** How many questions are remembered. A picker asks about a few dozen words in a
 *  day; past this the oldest goes, which keeps a shared map from being somewhere
 *  memory quietly accumulates. */
const MOST_REMEMBERED = 200;

function remembered(key: string, freshMs: number): TenorResult[] | null {
    const known = answers.get(key);
    if (!known) return null;
    if (Date.now() - known.at > freshMs) {
        answers.delete(key);
        return null;
    }
    return known.results;
}

function remember(key: string, results: TenorResult[]): void {
    // Nothing came back is not an answer worth keeping: it is usually the
    // service being slow, and keeping it would leave the tab empty for half an
    // hour over one bad moment.
    if (results.length === 0) return;
    if (answers.size >= MOST_REMEMBERED) {
        const oldest = answers.keys().next().value;
        if (oldest !== undefined) answers.delete(oldest);
    }
    answers.set(key, { at: Date.now(), results });
}

/** The biggest thing worth pulling down and keeping. Tenor's `tinygif` is well
 *  under this; the cap is here because the address is theirs, not ours. */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** The key an administrator connected, or the one this instance was started
 *  with. Empty when the search is simply not switched on here. */
async function tenorKey(): Promise<string> {
    const state = await getIntegrationState("tenor").catch(() => null);
    if (state?.enabled) {
        const secret = await getIntegrationSecret("tenor").catch(() => null);
        if (secret) return secret;
    }
    return loadEnv().POLARIS_TENOR_KEY ?? "";
}

/** The key for Giphy, which has no environment fallback: it arrived with the
 *  integrations screen and has never been configured any other way. */
async function giphyKey(): Promise<string> {
    const state = await getIntegrationState("giphy").catch(() => null);
    if (!state?.enabled) return "";
    return (await getIntegrationSecret("giphy").catch(() => null)) ?? "";
}

/** Whether the picker has a search tab at all. */
export async function tenorConfigured(): Promise<boolean> {
    const [giphy, tenor] = await Promise.all([giphyKey(), tenorKey()]);
    return giphy !== "" || tenor !== "";
}

/**
 * Search, or the featured list when nothing has been typed.
 *
 * A failure comes back as an empty list rather than an exception: the picker is
 * a convenience beside a working emoji tab, and a third party being slow should
 * not be an error somebody has to dismiss to carry on typing.
 *
 * The answer is remembered for everybody. Opening the GIF tab asks for the same
 * featured list every time, and both services charge for it - so the second
 * person to open it today is answered from here rather than from their quota.
 */
export async function searchTenor(query: string, kind: TenorKind): Promise<TenorResult[]> {
    const term = query.trim();
    const cacheKey = `${kind}:${term.toLowerCase()}`;
    const freshMs = term ? SEARCH_FRESH_MS : TRENDING_FRESH_MS;

    const known = remembered(cacheKey, freshMs);
    if (known) return known;

    const found = await askTheService(term, kind);
    remember(cacheKey, found);
    return found;
}

/** Whichever service is connected, asked directly. */
async function askTheService(term: string, kind: TenorKind): Promise<TenorResult[]> {
    const giphy = await giphyKey();
    if (giphy) return searchGiphy(giphy, term, kind);

    const key = await tenorKey();
    if (!key) return [];

    const base = term ? "search" : "featured";
    const url = new URL(`https://tenor.googleapis.com/v2/${base}`);
    url.searchParams.set("key", key);
    // Tenor asks callers to identify themselves so one integration's traffic is
    // distinguishable from another's.
    url.searchParams.set("client_key", "polaris");
    url.searchParams.set("limit", String(PAGE));
    url.searchParams.set("media_filter", "tinygif,gif");
    url.searchParams.set("contentfilter", "medium");
    if (term) url.searchParams.set("q", term);
    if (kind === "sticker") url.searchParams.set("searchfilter", "sticker");

    try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return [];
        const payload = (await response.json()) as { results?: RawResult[] };
        return (payload.results ?? []).flatMap(toResult);
    } catch {
        return [];
    }
}

/**
 * The same search, asked of Giphy.
 *
 * Through their own SDK rather than by hand, which is what they ask callers to
 * do and is the difference between one dependency and a private copy of their
 * URL shapes that goes stale quietly. It runs here and never in a browser: the
 * key is the instance's.
 *
 * Stickers are a type rather than a filter there, which is the one place the two
 * services genuinely differ - and it is spelled out here so the picker does not
 * have to know.
 */
async function searchGiphy(key: string, query: string, kind: TenorKind): Promise<TenorResult[]> {
    const term = query.trim();
    const type = kind === "sticker" ? "stickers" : "gifs";

    try {
        const gf = new GiphyFetch(key);
        const answer = term
            ? await gf.search(term, { limit: PAGE, type, rating: "pg-13" })
            : await gf.trending({ limit: PAGE, type, rating: "pg-13" });
        return (answer.data ?? []).flatMap(fromGiphy);
    } catch {
        // Same rule as Tenor's: a third party being slow is not an error
        // somebody has to dismiss to carry on typing.
        return [];
    }
}

/** One Giphy result in the shape the picker already draws. */
function fromGiphy(raw: IGif): TenorResult[] {
    const small = raw.images?.fixed_width_small ?? raw.images?.fixed_width;
    const full = raw.images?.original ?? small;
    if (!small?.url || !full?.url) return [];
    return [
        {
            id: String(raw.id),
            preview: small.url,
            full: full.url,
            description: raw.alt_text || raw.title || "",
            width: Number(small.width) || 0,
            height: Number(small.height) || 0
        }
    ];
}

/**
 * Pull a picture down from an address, so it can be stored like any other
 * attachment.
 *
 * Used for a GIF chosen in the picker and for one somebody pasted the address
 * of, which is the same act: a picture that lives somewhere else and is about to
 * live here instead.
 *
 * This once accepted only Tenor's own hosts, which was the wrong shape of
 * defence - it protected the network by refusing every other site, so a picture
 * kept from a link could not be sent again and an instance with no Tenor key
 * could not send one at all. The network is protected by `safe-fetch`, which
 * refuses private addresses at every redirect hop; the caps below are what keep
 * this from being a way to fill a disk.
 */
export async function fetchRemoteMedia(
    address: string
): Promise<{ name: string; type: string; bytes: Uint8Array } | null> {
    const found = await fetchImage(address, MAX_MEDIA_BYTES);
    if (!found) return null;
    return { name: found.name || "animation.gif", type: found.contentType, bytes: found.bytes };
}

interface RawFormat {
    url?: string;
    dims?: number[];
}

interface RawResult {
    id?: string;
    content_description?: string;
    media_formats?: Record<string, RawFormat>;
}

function toResult(raw: RawResult): TenorResult[] {
    const preview = raw.media_formats?.tinygif?.url;
    const full = raw.media_formats?.gif?.url ?? preview;
    if (!raw.id || !preview || !full) return [];
    const dims = raw.media_formats?.tinygif?.dims ?? [];
    return [
        {
            id: raw.id,
            preview,
            full,
            description: raw.content_description ?? "",
            width: dims[0] ?? 0,
            height: dims[1] ?? 0
        }
    ];
}
