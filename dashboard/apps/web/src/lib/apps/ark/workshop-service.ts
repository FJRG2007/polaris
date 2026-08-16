/**
 * Asking Steam about the mods on the Workshop, for one ARK server.
 *
 * All of it runs on the server rather than in the browser: the dashboard should
 * not make the operator's machine talk to Steam to render a page, and what comes
 * back is other people's text, so it is validated into a known shape before
 * anything renders it.
 *
 * Two different calls, because Steam gates them differently. Turning an id into a
 * real mod - its name, its size, the picture, and whether it is even an ARK mod -
 * needs no key at all, which is what makes "paste a Workshop link" work on a fresh
 * install with nothing configured. Searching does need a Web API key, and Polaris
 * already asks for one optionally under Integrations for the Steam sign-in, so
 * that is the key this uses. Without it the screen says so and still takes a link.
 *
 * Nothing is downloaded here. The server installs what its mod list names when it
 * next starts.
 */

import { z } from "zod";
import { getIntegrationSecret } from "@/lib/integration-service";
import { ARK_APP_ID, isWorkshopImage, type WorkshopItem } from "@/lib/apps/ark/workshop";

const DETAILS_URL = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const SEARCH_URL = "https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/";

/** Steam's own name for "sorted by how many people subscribe to it", which is the
 *  order anybody browsing mods actually wants. */
const BY_SUBSCRIPTIONS = 9;

const TIMEOUT_MS = 8000;

/** Enough to fill a page of results, and a ceiling on what one call can pull. */
export const MAX_RESULTS = 24;

const detailSchema = z.object({
    publishedfileid: z.string().max(32),
    /** 1 means Steam found it. Anything else is an id that names nothing. */
    result: z.number().optional(),
    title: z.string().max(300).catch(""),
    description: z.string().max(20000).catch(""),
    preview_url: z.string().max(1024).nullish().catch(null),
    file_size: z.union([z.string(), z.number()]).nullish().catch(null),
    subscriptions: z.number().nullish().catch(null),
    time_updated: z.number().nullish().catch(null),
    consumer_app_id: z.number().nullish().catch(null),
    creator_app_id: z.number().nullish().catch(null),
    banned: z.union([z.boolean(), z.number()]).nullish().catch(null)
});

const detailsSchema = z.object({
    response: z.object({
        publishedfiledetails: z.array(detailSchema).max(64).catch([])
    })
});

/** The first sentences of a description, with the Workshop's own bracket markup
 *  taken out - it is quoted into a caption, never rendered as anything. */
function summarize(description: string): string {
    return description
        .replace(/\[[^\]]{1,40}\]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
}

function toItem(row: z.infer<typeof detailSchema>): WorkshopItem {
    const size = typeof row.file_size === "string" ? Number(row.file_size) : (row.file_size ?? null);
    return {
        id: row.publishedfileid,
        title: row.title || row.publishedfileid,
        summary: summarize(row.description),
        previewUrl: isWorkshopImage(row.preview_url) ? (row.preview_url as string) : null,
        sizeBytes: Number.isFinite(size) && size !== null ? Number(size) : null,
        subscriptions: row.subscriptions ?? null,
        updatedAt: row.time_updated ? new Date(row.time_updated * 1000).toISOString() : null,
        // Either side of the pair is enough: a mod made with one game's tools for
        // another's is not a thing, and Steam fills the two in inconsistently for
        // very old items.
        forArk: row.consumer_app_id === ARK_APP_ID || row.creator_app_id === ARK_APP_ID,
        gone: row.result !== undefined && row.result !== 1 ? true : Boolean(row.banned)
    };
}

/**
 * What Steam says about these ids.
 *
 * Needs no key, which is the whole reason adding a mod by its link works on an
 * instance where nobody has configured anything. Resolves empty when Steam cannot
 * be reached - a list of ids nobody could look up is still a list the screen draws,
 * with the ids in it.
 */
export async function readWorkshopItems(ids: readonly string[]): Promise<WorkshopItem[]> {
    const wanted = [...new Set(ids)].filter((id) => /^\d{6,12}$/.test(id)).slice(0, 64);
    if (wanted.length === 0) return [];
    const body = new URLSearchParams({ itemcount: String(wanted.length) });
    wanted.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
    const answer = await fetch(DETAILS_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    }).catch(() => null);
    if (!answer?.ok) return [];
    const parsed = detailsSchema.safeParse(await answer.json().catch(() => null));
    return parsed.success ? parsed.data.response.publishedfiledetails.map(toItem) : [];
}

/** One mod, or null when Steam does not know that id. */
export async function readWorkshopItem(id: string): Promise<WorkshopItem | null> {
    const [found] = await readWorkshopItems([id]);
    return found ?? null;
}

const searchSchema = z.object({
    response: z.object({
        publishedfiledetails: z.array(detailSchema).max(64).catch([])
    })
});

export interface WorkshopSearch {
    readonly items: readonly WorkshopItem[];
    /** True when nobody has given Polaris a Steam Web API key, which is the one
     *  thing standing between this screen and a search box that works. Said out
     *  loud rather than shown as "no results". */
    readonly needsKey: boolean;
}

/**
 * Mods matching what somebody typed, most subscribed first.
 *
 * Steam requires a Web API key for this one call and for no other part of this
 * feature. Polaris already asks for one optionally under Integrations, so this
 * reuses it rather than asking for a second.
 */
export async function searchWorkshop(query: string, limit = 20): Promise<WorkshopSearch> {
    const key = await getIntegrationSecret("steam").catch(() => null);
    if (!key) return { items: [], needsKey: true };
    const url = new URL(SEARCH_URL);
    url.searchParams.set("key", key);
    url.searchParams.set("appid", String(ARK_APP_ID));
    url.searchParams.set("query_type", String(BY_SUBSCRIPTIONS));
    url.searchParams.set("numperpage", String(Math.min(Math.max(limit, 1), MAX_RESULTS)));
    url.searchParams.set("return_previews", "true");
    url.searchParams.set("return_short_description", "true");
    if (query.trim().length > 0) url.searchParams.set("search_text", query.trim().slice(0, 100));
    const answer = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!answer?.ok) return { items: [], needsKey: false };
    const parsed = searchSchema.safeParse(await answer.json().catch(() => null));
    if (!parsed.success) return { items: [], needsKey: false };
    // The query is already scoped to ARK, but an item Steam has taken down is one
    // nothing should offer to install.
    return {
        items: parsed.data.response.publishedfiledetails.map(toItem).filter((item) => !item.gone),
        needsKey: false
    };
}
