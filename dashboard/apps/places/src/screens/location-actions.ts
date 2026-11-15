"use server";

/**
 * Finding a city or an address by name, for a place's location and a weather
 * card's. Only somebody who manages the house sets either, so only they search.
 */

import { host } from "@polaris/app-host";
import { requireHome } from "../lib/access";
import { searchPlaces } from "../lib/geocoding";
import { geocodeQuerySchema, type GeoPlace } from "../lib/geocoding-kinds";

/** Places matching the search; `failed` when the service did not answer. */
export async function searchLocationsAction(
    query: unknown
): Promise<{ places: GeoPlace[]; failed?: boolean }> {
    await requireHome("home.manage");
    const parsed = geocodeQuerySchema.safeParse(query);
    if (!parsed.success) return { places: [] };
    const places = await searchPlaces(parsed.data, await host.i18nRequest.getLocale());
    return places ? { places } : { places: [], failed: true };
}
