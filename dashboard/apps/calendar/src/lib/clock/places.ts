/**
 * Any place's time zone, by name: a city, a town or a village anywhere, looked
 * up in Open-Meteo's geocoder (free, no key), which answers each place with its
 * IANA zone. The world clock's own list of zones answers first and offline;
 * this is for the towns that list has no entry for.
 *
 * Fetched through the host's guarded fetch, read capped, and checked against a
 * schema before anything of it is used; a zone this runtime cannot read is
 * dropped. Answers are kept for a few minutes, so a search typed twice - or by
 * two people - asks once.
 *
 * Server-only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { isKnownZone } from "../schemas";

const ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const MAX_BYTES = 256 * 1024;
const RESULTS = 10;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

export const PLACE_QUERY_MAX = 80;

export const placeQuerySchema = z.object({
    query: z.string().trim().min(2).max(PLACE_QUERY_MAX),
    /** "es", "en": the language names come back in. */
    language: z
        .string()
        .trim()
        .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/)
        .transform((value) => value.split("-")[0]!.toLowerCase())
});

export interface PlaceResult {
    /** "Alcobendas". */
    readonly name: string;
    /** "Madrid": the region, when it adds something to the name. */
    readonly region: string;
    /** "Spain", in the language asked for. */
    readonly country: string;
    readonly zone: string;
    readonly latitude: number;
    readonly longitude: number;
}

const text = z.string().max(200).optional().catch(undefined);

const answerSchema = z.object({
    results: z
        .array(
            z.object({
                name: z.string().min(1).max(200),
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                timezone: z.string().min(1).max(64).optional().catch(undefined),
                admin1: text,
                country: text
            })
        )
        .max(100)
        .optional()
});

/** The search could not be answered: the geocoder is down, slow or unreachable. */
export class PlaceSearchError extends Error {
    public constructor(cause: string) {
        super(cause);
        this.name = "PlaceSearchError";
    }
}

const cache = new Map<string, { at: number; places: PlaceResult[] }>();

/** Places called `query`, best first, each with a zone this runtime can read. */
export async function searchPlaces(
    query: string,
    language: string,
    now = Date.now()
): Promise<PlaceResult[]> {
    const key = `${language}\u0000${query.toLowerCase()}`;
    const kept = cache.get(key);
    if (kept && now - kept.at < CACHE_MS) return kept.places;

    const url = new URL(ENDPOINT);
    url.searchParams.set("name", query);
    url.searchParams.set("count", String(RESULTS));
    url.searchParams.set("language", language);
    url.searchParams.set("format", "json");

    let body: unknown;
    try {
        const response = await host.safeFetch.follow(url, "application/json");
        if (!response) throw new PlaceSearchError("no answer");
        if (!response.ok) throw new PlaceSearchError(`status ${response.status}`);
        const bytes = await host.safeFetch.readCapped(response, MAX_BYTES);
        if (!bytes) throw new PlaceSearchError("answer too large");
        body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (caught) {
        if (caught instanceof PlaceSearchError) throw caught;
        throw new PlaceSearchError(caught instanceof Error ? caught.message : "fetch failed");
    }
    const parsed = answerSchema.safeParse(body);
    if (!parsed.success) throw new PlaceSearchError("unexpected answer");

    const places: PlaceResult[] = [];
    for (const result of parsed.data.results ?? []) {
        if (!result.timezone || !isKnownZone(result.timezone)) continue;
        const region = result.admin1 && result.admin1 !== result.name ? result.admin1 : "";
        places.push({
            name: result.name,
            region,
            country: result.country ?? "",
            zone: result.timezone,
            latitude: result.latitude,
            longitude: result.longitude
        });
    }

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, places });
    return places;
}

/** "Alcobendas, Madrid, Spain": what the world clock shows for a place. */
export function placeLabel(place: Pick<PlaceResult, "name" | "region" | "country">): string {
    return [place.name, place.region, place.country].filter(Boolean).join(", ");
}

/** Forget every kept answer. For tests. */
export function clearPlaceCache(): void {
    cache.clear();
}
