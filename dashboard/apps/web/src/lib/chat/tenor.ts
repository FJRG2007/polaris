/**
 * GIFs and stickers, from Tenor.
 *
 * Server-side only, and that is the point of the module existing at all: the API
 * key is instance configuration and must not reach a browser, where it would be
 * one view-source away from being somebody else's quota.
 *
 * The key is an integration an administrator connects, like every other outside
 * service. An environment variable is still read as a fallback, so an instance
 * that set one before this screen existed keeps working.
 *
 * Nothing is stored here. What comes back is a list of addresses the picker
 * draws; choosing one is what stores something, and what it stores is an
 * ordinary attachment - see `fetchRemoteMedia`. That is deliberate: a message
 * whose GIF is a link to Tenor is a message that tells Tenor who read it and
 * when, and that stops working the day they take the file down.
 */

import { loadEnv } from "@polaris/config";
import { fetchImage } from "@/lib/safe-fetch";
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

export async function tenorConfigured(): Promise<boolean> {
    return (await tenorKey()) !== "";
}

/**
 * Search, or the featured list when nothing has been typed.
 *
 * A failure comes back as an empty list rather than an exception: the picker is
 * a convenience beside a working emoji tab, and a third party being slow should
 * not be an error somebody has to dismiss to carry on typing.
 */
export async function searchTenor(query: string, kind: TenorKind): Promise<TenorResult[]> {
    const key = await tenorKey();
    if (!key) return [];

    const term = query.trim();
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
