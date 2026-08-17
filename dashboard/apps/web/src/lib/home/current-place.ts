/**
 * Which place the person looking at Polaris is currently in.
 *
 * Every screen in this app is about one place: the wall, what happened, what was
 * kept, the alerts. So the choice is made once, in the header, and read
 * everywhere - the same shape as the workspace shelf switch, and for the same
 * reason it is a cookie: it has to survive a reload and a new tab, and it has to
 * be readable by a server component before anything paints. A place fetched
 * after the fact is a screenful of the wrong building.
 *
 * An unknown or deleted id silently falls back to the first place rather than
 * erroring. The cookie is whatever the browser presents, and "the first one" is
 * an answer that is always true.
 *
 * Server-only.
 */

import { cache } from "react";
import { cookies } from "next/headers";
import { listPlaces, type PlaceView } from "@/lib/home/places";

/** The cookie the switch writes. Not http-only: the switcher reads it to draw
 *  itself, and it names an id that is checked server-side on every read. */
export const PLACE_COOKIE = "polaris.place";

/** A year. Which building somebody watches is a standing preference, not a
 *  detail of one session. */
export const PLACE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export interface PlaceContext {
    readonly current: PlaceView;
    readonly places: readonly PlaceView[];
}

/**
 * The chosen place and everything to choose from, resolved once per render.
 *
 * `cache` because several things on one screen ask - the header draws the
 * switcher, the page reads the id, the rail counts what is in it - and they must
 * agree as well as not repeat the query.
 */
export const currentPlace = cache(async (installedAppId: string): Promise<PlaceContext> => {
    const places = await listPlaces(installedAppId);
    const chosen = (await cookies()).get(PLACE_COOKIE)?.value ?? "";
    // places is never empty: listPlaces creates the first one.
    const current = places.find((place) => place.id === chosen) ?? places[0]!;
    return { current, places };
});
