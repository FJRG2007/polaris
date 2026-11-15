/**
 * Places found by name, asked of Open-Meteo's geocoding API through the host's
 * guarded fetch, with its time and byte ceiling, as the weather is
 * (`panel-weather.ts`). An answer is kept for a day per search and language -
 * a city does not move - and a failure for two minutes.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { geocodeUrl, parseGeocoding, type GeoPlace } from "./geocoding-kinds";

const KEEP_MS = 24 * 60 * 60_000;
const KEEP_FAILED_MS = 2 * 60_000;
/** Far more than eight results are. */
const ANSWER_BYTES = 64 * 1024;
const KEPT_MAX = 500;

const kept = new Map<string, { at: number; places: GeoPlace[] | null }>();

async function ask(query: string, language: string): Promise<GeoPlace[] | null> {
    try {
        const response = await host.safeFetch.follow(
            geocodeUrl(query, language),
            "application/json"
        );
        if (!response) return null;
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const bytes = await host.safeFetch.readCapped(response, ANSWER_BYTES);
        if (!bytes) return null;
        return parseGeocoding(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

/** Places matching a search (already normalized), or null when the service
 *  did not answer. */
export async function searchPlaces(
    query: string,
    language: string,
    now = Date.now()
): Promise<GeoPlace[] | null> {
    const key = `${language}:${query.toLowerCase()}`;
    const hit = kept.get(key);
    if (hit && now - hit.at < (hit.places ? KEEP_MS : KEEP_FAILED_MS)) return hit.places;
    const places = await ask(query, language);
    kept.delete(key);
    if (kept.size >= KEPT_MAX) kept.delete(kept.keys().next().value!);
    kept.set(key, { at: now, places });
    return places;
}

/** Forget every kept answer. For tests. */
export function forgetPlaces(): void {
    kept.clear();
}
