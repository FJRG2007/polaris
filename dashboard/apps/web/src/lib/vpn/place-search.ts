/**
 * Finding a place for a VPN server by hand: a town typed by name, or a spot given
 * by its coordinates. Both are free and need no key - the name search is
 * Open-Meteo's geocoding, the one the weather tool already uses, and the
 * coordinates are named by OpenStreetMap's Nominatim. Both go through the guarded
 * fetch, with its time and byte ceiling, and both answers are checked against a
 * schema before anything is shown. The hosts are fixed; what was typed only
 * reaches the query string.
 *
 * Server-only.
 */

import { z } from "zod";
import { follow, readCapped } from "@/lib/safe-fetch";

const SEARCH_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const ANSWER_BYTES = 256 * 1024;
const MATCHES = 8;
/** Answers kept so retyping a search, or a second admin placing the same town,
 *  asks nobody again. Bounded by count and age; a failed ask is never kept. */
const KEPT = 200;
const KEPT_MS = 24 * 60 * 60 * 1000;
const kept = new Map<string, { at: number; value: unknown }>();

async function remembered<T>(key: string, ask: () => Promise<T | null>): Promise<T | null> {
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEPT_MS) return hit.value as T;
    kept.delete(key);
    const value = await ask();
    if (value === null) return null;
    if (kept.size >= KEPT) kept.delete(kept.keys().next().value as string);
    kept.set(key, { at: Date.now(), value });
    return value;
}

export interface PlaceMatch {
    readonly country: string;
    readonly city: string | null;
    /** The region, so two towns of one name can be told apart. */
    readonly region: string | null;
    readonly latitude: number;
    readonly longitude: number;
}

const COUNTRY = z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/));

const searchSchema = z.object({
    results: z
        .array(
            z.object({
                name: z.string().min(1),
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                country_code: z.string().optional(),
                admin1: z.string().optional()
            })
        )
        .optional()
});

const reverseSchema = z.object({
    address: z
        .object({
            country_code: z.string().optional(),
            city: z.string().optional(),
            town: z.string().optional(),
            village: z.string().optional(),
            municipality: z.string().optional(),
            state: z.string().optional()
        })
        .optional()
});

/** A name from another service, one line and bounded. */
function clean(value: string | undefined): string | null {
    const text = (value ?? "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 80);
    return text || null;
}

async function getJson<T>(url: URL, schema: z.ZodType<T>): Promise<T | null> {
    const response = await follow(url, "application/json");
    if (!response) return null;
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    const bytes = await readCapped(response, ANSWER_BYTES);
    if (!bytes) return null;
    try {
        const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** The matches of a search answer that name a country. Pure; exported for tests. */
export function matchesOf(answer: z.infer<typeof searchSchema>): PlaceMatch[] {
    return (answer.results ?? []).flatMap((result) => {
        const country = COUNTRY.safeParse(result.country_code ?? "");
        if (!country.success) return [];
        return [
            {
                country: country.data,
                city: clean(result.name),
                region: clean(result.admin1),
                latitude: result.latitude,
                longitude: result.longitude
            }
        ];
    });
}

/** What a reverse answer says is at a spot, or null for the sea. Pure; exported for tests. */
export function placeAt(
    answer: z.infer<typeof reverseSchema>,
    latitude: number,
    longitude: number
): PlaceMatch | null {
    const address = answer.address;
    const country = COUNTRY.safeParse(address?.country_code ?? "");
    if (!country.success) return null;
    return {
        country: country.data,
        city: clean(address?.city ?? address?.town ?? address?.village ?? address?.municipality),
        region: clean(address?.state),
        latitude,
        longitude
    };
}

/** Towns by name, best first. Null when the service could not be asked. */
export async function searchPlaces(query: string, language: string): Promise<PlaceMatch[] | null> {
    const url = new URL(SEARCH_URL);
    url.search = new URLSearchParams({
        name: query,
        count: String(MATCHES),
        language,
        format: "json"
    }).toString();
    const answer = await remembered(`search:${language}:${query.toLowerCase()}`, () =>
        getJson(url, searchSchema)
    );
    return answer ? matchesOf(answer) : null;
}

/** What is at a spot. Undefined when the service could not be asked, null for no country. */
export async function placeOfPoint(
    latitude: number,
    longitude: number,
    language: string
): Promise<PlaceMatch | null | undefined> {
    const url = new URL(REVERSE_URL);
    url.search = new URLSearchParams({
        format: "jsonv2",
        lat: String(latitude),
        lon: String(longitude),
        zoom: "10",
        "accept-language": language
    }).toString();
    const answer = await remembered(`point:${language}:${latitude},${longitude}`, () =>
        getJson(url, reverseSchema)
    );
    return answer ? placeAt(answer, latitude, longitude) : undefined;
}
