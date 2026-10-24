/**
 * Which Overview cards have nothing to show, so the grid can sink them below the
 * ones that do (see `rankOverviewLayout`).
 *
 * Only a card read successfully and found empty counts: one still loading, one
 * that failed to read, or one this browser fills on its own (history, the
 * notification feed) keeps its place. The same conditions the cards use to draw
 * their own empty state.
 *
 * The answer is mirrored in a cookie so the next visit is drawn in its settled
 * order by the server, instead of moving once the figures land. Client-safe: no
 * server imports.
 */

import { OVERVIEW_WIDGET_IDS, type OverviewWidgetId } from "@polaris/core";
import type { OverviewData } from "./overview-service";

export const EMPTY_CARDS_COOKIE = "polaris-overview-empty";

/** A month: it is a hint for the first paint, refreshed on every visit. */
const EMPTY_CARDS_MAX_AGE = 30 * 24 * 60 * 60;

/** The cards with nothing in them, out of the ones whose answer is known. */
export function emptyOverviewCards(
    data: OverviewData,
    local: { shortcuts: number; apps: number }
): Set<OverviewWidgetId> {
    const empty = new Set<OverviewWidgetId>();
    if (local.shortcuts === 0) empty.add("shortcuts");
    if (local.apps === 0) empty.add("apps");
    if (data.services && data.services.total === 0) empty.add("services");
    if (data.usage && data.usage.length === 0) empty.add("usage");
    if (data.alarms && data.alarms.firing === 0 && data.alarms.events.length === 0)
        empty.add("alarms");
    if (data.tasks && data.tasks.assigned === 0) empty.add("tasks");
    if (data.storage && data.storage.length === 0) empty.add("storage");
    if (data.sessions && data.sessions.entries.length === 0) empty.add("sessions");
    if (data.activity && data.activity.length === 0) empty.add("activity");
    if (data.games && data.games.total === 0) empty.add("games");
    if (data.calendar && data.calendar.events.length === 0) empty.add("calendar");
    return empty;
}

/** The cookie's value back as card ids. Anything that is not one is dropped:
 *  the cookie is written by the browser and read as untrusted input. */
export function parseEmptyCardsCookie(value: string | null | undefined): OverviewWidgetId[] {
    if (!value) return [];
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        return [];
    }
    const known = new Set<string>(OVERVIEW_WIDGET_IDS);
    return [...new Set(decoded.split(",").filter((id): id is OverviewWidgetId => known.has(id)))];
}

/** Write the mirror from the browser. `Secure` follows the page, so it works on
 *  the plain-HTTP LAN address as well as on the domain. */
export function writeEmptyCardsCookie(ids: Iterable<OverviewWidgetId>): void {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    const value = encodeURIComponent([...ids].sort().join(","));
    document.cookie = `${EMPTY_CARDS_COOKIE}=${value}; Path=/; Max-Age=${EMPTY_CARDS_MAX_AGE}; SameSite=Lax${secure}`;
}
