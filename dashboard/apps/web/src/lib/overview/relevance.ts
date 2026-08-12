/**
 * Which cards are worth the top of the grid, for a reader who has not said.
 *
 * A landing screen shipped in one fixed order is wrong for almost everybody: an
 * account with no alarms configured gets a card that says "no alarms" above the
 * work assigned to them, and somebody who lives in one app finds it below four
 * they never open. Both are answerable without asking anything - a card knows
 * whether it had anything in it, and the browser already remembers where this
 * person has been.
 *
 * Two rules, in this order:
 *
 *   1. A card that had nothing in it last time sinks below the ones that did.
 *      Last time, not this time: emptiness is only known once the figures land,
 *      and rearranging the grid under somebody a second after it painted is
 *      worse than being one visit late.
 *   2. Among the rest, a card whose screen this browser has been to recently
 *      rises, most-visited first.
 *
 * Both apply ONLY to cards the reader has never moved, resized or turned off.
 * An arrangement somebody made themselves is never overruled by a guess: those
 * cards keep the exact positions they were in, and the rest are ranked into
 * whatever positions are left.
 */

import { overviewWidget } from "./catalog";
import { readRecentPlaces } from "./recent-places";
import type { OverviewData } from "./overview-service";
import type { OverviewWidgetId, OverviewWidgetPreference } from "@polaris/core";

const EMPTY_KEY = "polaris.overview.empty";

/** Cards that had nothing in them the last time the figures were read here. */
export function readEmptyCards(): Set<OverviewWidgetId> {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = window.localStorage.getItem(EMPTY_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        // Written by us, but also by another tab, an extension, or a build of
        // Polaris that knew different card names. Anything unrecognisable is
        // simply not a card, and ranks nothing.
        return new Set(Array.isArray(parsed) ? parsed.filter((id): id is OverviewWidgetId => typeof id === "string") : []);
    } catch {
        return new Set();
    }
}

export function rememberEmptyCards(ids: readonly OverviewWidgetId[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(EMPTY_KEY, JSON.stringify(ids));
    } catch {
        // Storage denied (private mode, blocked cookies). The grid keeps its
        // shipped order, which is the same thing it did before any of this.
    }
}

/**
 * The cards that came back with nothing to show.
 *
 * A card whose read failed is not empty - nobody knows what is in it - and a
 * card that was not asked for is not either. Only a definite "there is nothing
 * here" counts, which is why every arm tests the value rather than its absence.
 */
export function emptyCards(data: OverviewData, local: { shortcuts: number; apps: number }): OverviewWidgetId[] {
    const empty: OverviewWidgetId[] = [];
    if (data.services && data.services.total === 0) empty.push("services");
    if (data.usage && data.usage.length === 0) empty.push("usage");
    if (data.alarms && data.alarms.firing === 0 && data.alarms.events.length === 0) empty.push("alarms");
    if (data.tasks && data.tasks.assigned === 0) empty.push("tasks");
    if (data.storage && data.storage.length === 0) empty.push("storage");
    if (data.games && data.games.total === 0) empty.push("games");
    if (data.activity && data.activity.length === 0) empty.push("activity");
    if (local.shortcuts === 0) empty.push("shortcuts");
    if (local.apps === 0) empty.push("apps");
    return empty;
}

/**
 * How much of this browser's recent history belongs to each card's subject.
 *
 * Weighted by how recently, so the app somebody was in ten minutes ago outranks
 * one they opened once last week. The history holds a handful of paths and one
 * entry per path, so this is a rough signal by construction - enough to lift a
 * card, never enough to bury one.
 */
function visitWeights(): Map<OverviewWidgetId, number> {
    const places = readRecentPlaces();
    const weights = new Map<OverviewWidgetId, number>();
    places.forEach((place, index) => {
        const weight = places.length - index;
        for (const id of CARDS_BY_SUBJECT) {
            const entry = overviewWidget(id);
            const paths = [entry.href, ...(entry.paths ?? [])].filter((path): path is string => Boolean(path));
            if (paths.some((path) => place.href === path || place.href.startsWith(`${path}/`))) {
                weights.set(id, (weights.get(id) ?? 0) + weight);
            }
        }
    });
    return weights;
}

/** Only the cards that are a window onto a screen can be weighted by visits to
 *  it; the rest (the launcher, the pinned links, this browser's own history) are
 *  not about anywhere. */
const CARDS_BY_SUBJECT: readonly OverviewWidgetId[] = [
    "services",
    "usage",
    "alarms",
    "storage",
    "tasks",
    "games",
    "sessions",
    "activity",
    "notifications"
];

/**
 * The grid's order, with the cards nobody has arranged ranked into the positions
 * they occupy.
 *
 * The positions themselves do not move: whatever slots the unarranged cards were
 * in, they are still in, filled in ranked order. That is what keeps a card the
 * reader dragged to the top from being pushed down by a card that scored better.
 */
export function relevanceOrder(
    widgets: readonly OverviewWidgetPreference[],
    arranged: ReadonlySet<OverviewWidgetId>
): OverviewWidgetPreference[] {
    const slots = widgets.map((_, index) => index).filter((index) => !arranged.has(widgets[index]!.id));
    if (slots.length < 2) return [...widgets];

    const empty = readEmptyCards();
    const weights = visitWeights();
    const ranked = slots
        .map((index) => ({ widget: widgets[index]!, at: index }))
        .sort(
            (left, right) =>
                Number(empty.has(left.widget.id)) - Number(empty.has(right.widget.id)) ||
                (weights.get(right.widget.id) ?? 0) - (weights.get(left.widget.id) ?? 0) ||
                // Everything else equal, the order they were already in - which is
                // the order the catalogue ships them in.
                left.at - right.at
        );

    const next = [...widgets];
    slots.forEach((slot, index) => {
        next[slot] = ranked[index]!.widget;
    });
    return next;
}
