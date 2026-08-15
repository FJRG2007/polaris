/**
 * GIFs and stickers, from Tenor.
 *
 * Server-side only, and that is the point of the module existing at all: the API
 * key is instance configuration and must not reach a browser, where it would be
 * one view-source away from being somebody else's quota.
 *
 * Nothing is stored here. What comes back is a list of addresses the picker
 * draws; choosing one is what stores something, and what it stores is an
 * ordinary attachment - see `fetchRemoteMedia`. That is deliberate: a message
 * whose GIF is a link to Tenor is a message that tells Tenor who read it and
 * when, and that stops working the day they take the file down.
 */

import { loadEnv } from "@polaris/config";

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

/** The hosts a chosen result may actually be fetched from.
 *
 *  Without this the "send this address" call is an open fetch proxy with a
 *  Polaris login in front of it - hand it any URL and the server retrieves it,
 *  which reaches anything on the network Polaris is on. */
const ALLOWED_HOSTS = new Set(["media.tenor.com", "media1.tenor.com", "c.tenor.com", "tenor.com"]);

export function tenorConfigured(): boolean {
    return Boolean(loadEnv().POLARIS_TENOR_KEY);
}

/**
 * Search, or the featured list when nothing has been typed.
 *
 * A failure comes back as an empty list rather than an exception: the picker is
 * a convenience beside a working emoji tab, and a third party being slow should
 * not be an error somebody has to dismiss to carry on typing.
 */
export async function searchTenor(query: string, kind: TenorKind): Promise<TenorResult[]> {
    const key = loadEnv().POLARIS_TENOR_KEY;
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
 * Pull one chosen result down, so it can be stored like any other attachment.
 *
 * The host is checked against the list above rather than trusted, because the
 * address arrives from a browser and a server that fetches whatever it is told
 * to is a way into the network it runs on.
 */
export async function fetchRemoteMedia(
    address: string
): Promise<{ name: string; type: string; bytes: Uint8Array } | null> {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;

    try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return null;

        const declared = response.headers.get("content-length");
        if (declared && Number(declared) > MAX_MEDIA_BYTES) return null;

        const bytes = new Uint8Array(await response.arrayBuffer());
        // Checked again after the fact: a missing or lying content-length is not
        // a reason to hold however much they decided to send.
        if (bytes.length > MAX_MEDIA_BYTES) return null;

        const type = response.headers.get("content-type") ?? "image/gif";
        if (!type.startsWith("image/")) return null;

        const name = url.pathname.split("/").pop() || "animation.gif";
        return { name, type: type.split(";")[0]!.trim(), bytes };
    } catch {
        return null;
    }
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
