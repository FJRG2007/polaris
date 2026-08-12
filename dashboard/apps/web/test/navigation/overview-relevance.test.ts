/**
 * Ranking the Overview cards nobody has arranged.
 *
 * The rules are cheap to state and easy to get backwards, and getting them
 * backwards is invisible - the grid still renders, in an order that quietly
 * buries the work somebody was assigned under a card that says "no alarms". So
 * each one is pinned here: empty sinks, visited rises, and a card the reader
 * placed themselves does not move for either.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { OverviewWidgetId, OverviewWidgetPreference } from "@polaris/core";

const store = new Map<string, string>();

// relevance.ts and recent-places.ts both read window.localStorage and both fall
// back to "know nothing" without one, so the store has to exist before they are
// imported for anything but the empty case to be reachable.
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
        localStorage: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key)
        }
    }
});

const { relevanceOrder, rememberEmptyCards } = await import("@/lib/overview/relevance");

const EMPTY_ARRANGED = new Set<OverviewWidgetId>();

function layout(...ids: OverviewWidgetId[]): OverviewWidgetPreference[] {
    return ids.map((id) => ({ id, size: "md" as const, hidden: false }));
}

function visited(...hrefs: string[]): void {
    store.set(
        "polaris.overview.recent",
        JSON.stringify(
            hrefs.map((href, index) => ({
                href,
                label: href,
                context: null,
                // Newest first is what the store holds; the timestamps only have
                // to disagree in the right direction.
                visitedAt: new Date(Date.UTC(2026, 0, 10 - index)).toISOString()
            }))
        )
    );
}

beforeEach(() => store.clear());

describe("ordering the cards nobody has arranged", () => {
    it("sinks the ones that had nothing in them", () => {
        rememberEmptyCards(["alarms"]);

        const order = relevanceOrder(layout("alarms", "tasks", "services"), EMPTY_ARRANGED);

        expect(order.map((widget) => widget.id)).toEqual(["tasks", "services", "alarms"]);
    });

    it("lifts the ones whose screen this browser keeps going to", () => {
        // A game server's own page, which is not the screen the card links to -
        // the card names it as its subject anyway.
        visited("/apps/installed/abc", "/apps/installed/def");

        const order = relevanceOrder(layout("services", "tasks", "games"), EMPTY_ARRANGED);

        expect(order[0]?.id).toBe("games");
    });

    it("leaves a card the reader placed exactly where they put it", () => {
        rememberEmptyCards(["alarms"]);

        // Alarms is empty and would otherwise sink, but this reader moved it.
        const order = relevanceOrder(layout("alarms", "tasks", "services"), new Set<OverviewWidgetId>(["alarms"]));

        expect(order.map((widget) => widget.id)).toEqual(["alarms", "tasks", "services"]);
    });

    it("keeps the shipped order when it knows nothing", () => {
        const ids = layout("services", "usage", "tasks", "alarms");

        expect(relevanceOrder(ids, EMPTY_ARRANGED).map((widget) => widget.id)).toEqual([
            "services",
            "usage",
            "tasks",
            "alarms"
        ]);
    });
});
