/**
 * Finding a place by name: what is asked of Open-Meteo's geocoding API
 * (https://open-meteo.com/en/docs/geocoding-api), the same service the weather
 * comes from, and what is read of its answer.
 *
 * Pure and client-safe: the server parses the answer with it and the screens
 * draw the results with it.
 */

import { z } from "zod";
import { roundCoordinate } from "@polaris/core";

export const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

/** The most results a search answers with. */
export const GEOCODE_RESULTS = 8;

/** A search, trimmed and with its spaces folded, as it is asked and cached. */
export const geocodeQuerySchema = z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(2).max(100));

/** One place a search found, its coordinate kept to about a kilometre. */
export interface GeoPlace {
    readonly id: string;
    readonly name: string;
    /** The region and country, for telling two places of one name apart. */
    readonly detail: string;
    readonly latitude: number;
    readonly longitude: number;
}

/** The search address for a name, answered in `language` where it can be. */
export function geocodeUrl(query: string, language: string): URL {
    const url = new URL(GEOCODING_URL);
    url.search = new URLSearchParams({
        name: query,
        count: String(GEOCODE_RESULTS),
        language: language.slice(0, 2).toLowerCase() || "en",
        format: "json"
    }).toString();
    return url;
}

const resultSchema = z.object({
    id: z.number().int().optional(),
    name: z.string().min(1).max(200),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    admin1: z.string().max(200).optional(),
    country: z.string().max(200).optional()
});
const answerSchema = z.object({ results: z.array(z.unknown()).max(100).optional() });

/** A geocoding answer as places, at most `GEOCODE_RESULTS`. A result that is
 *  not a place is skipped; an answer that is not one at all reads as none. */
export function parseGeocoding(body: unknown): GeoPlace[] {
    const parsed = answerSchema.safeParse(body);
    if (!parsed.success) return [];
    const places: GeoPlace[] = [];
    for (const raw of parsed.data.results ?? []) {
        const result = resultSchema.safeParse(raw);
        if (!result.success) continue;
        const { name, admin1, country } = result.data;
        const at = roundCoordinate(result.data);
        places.push({
            id: String(result.data.id ?? `${at.latitude},${at.longitude}`),
            name,
            detail: [admin1, country].filter((part) => part && part !== name).join(", "),
            latitude: at.latitude,
            longitude: at.longitude
        });
        if (places.length >= GEOCODE_RESULTS) break;
    }
    return places;
}
