/**
 * The Overview's stored layout.
 *
 * Three rules are worth protecting here, because each of them is a way somebody
 * loses their screen without touching it: a card whose permission the account no
 * longer holds must never be drawn from a saved layout, a card added to Polaris
 * after somebody arranged theirs must arrive where the catalogue puts it rather
 * than at the bottom, and an unreadable blob must cost the arrangement rather
 * than the page.
 */

import { describe, expect, it } from "vitest";
import * as overview from "../src/schemas/overview.js";

const {
    DEFAULT_OVERVIEW_LAYOUT,
    EMPTY_OVERVIEW_PREFERENCES,
    MAX_RECENT_PLACES,
    OVERVIEW_WIDGET_IDS,
    mergeRecentPlaces,
    overviewPreferencesSchema,
    parseOverviewPreferences,
    resolveOverviewLayout,
    stringifyOverviewPreferences
} = overview;

const ALL = [...OVERVIEW_WIDGET_IDS];

describe("the catalogue the layout is written in", () => {
    it("ships a default position for every card, exactly once", () => {
        const ids = DEFAULT_OVERVIEW_LAYOUT.map((widget) => widget.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(OVERVIEW_WIDGET_IDS));
    });
});

describe("parseOverviewPreferences", () => {
    it("reads back what was stored", () => {
        const stored = stringifyOverviewPreferences({
            widgets: [{ id: "usage", size: "lg", hidden: true }],
            shortcuts: [{ label: "Deploy", href: "/apps/deploy", context: "Apps" }],
            greeting: false
        });
        expect(parseOverviewPreferences(stored)).toEqual({
            widgets: [{ id: "usage", size: "lg", hidden: true }],
            shortcuts: [{ label: "Deploy", href: "/apps/deploy", context: "Apps" }],
            greeting: false
        });
    });

    it("costs the arrangement rather than the page when the blob is unusable", () => {
        expect(parseOverviewPreferences(null)).toEqual(EMPTY_OVERVIEW_PREFERENCES);
        expect(parseOverviewPreferences("{ not json")).toEqual(EMPTY_OVERVIEW_PREFERENCES);
        expect(parseOverviewPreferences(JSON.stringify({ widgets: [{ id: "nope" }] }))).toEqual(
            EMPTY_OVERVIEW_PREFERENCES
        );
    });
});

describe("what may be pinned", () => {
    it("refuses a link that leaves Polaris", () => {
        const external = overviewPreferencesSchema.safeParse({
            shortcuts: [{ label: "Elsewhere", href: "https://example.com/x" }]
        });
        expect(external.success).toBe(false);
        // A protocol-relative path is a link off the deployment wearing an
        // internal path's clothes.
        expect(
            overviewPreferencesSchema.safeParse({ shortcuts: [{ label: "Elsewhere", href: "//example.com" }] }).success
        ).toBe(false);
        expect(
            overviewPreferencesSchema.safeParse({ shortcuts: [{ label: "Deploy", href: "/apps/deploy" }] }).success
        ).toBe(true);
    });
});

describe("resolveOverviewLayout", () => {
    it("keeps the reader's own order", () => {
        const resolved = resolveOverviewLayout(
            {
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [
                    { id: "tasks", size: "sm", hidden: false },
                    { id: "shortcuts", size: "lg", hidden: false }
                ]
            },
            ["shortcuts", "tasks"]
        );
        expect(resolved.map((widget) => widget.id)).toEqual(["tasks", "shortcuts"]);
    });

    it("drops a saved card the account may no longer see", () => {
        const resolved = resolveOverviewLayout(
            {
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [
                    { id: "services", size: "md", hidden: false },
                    { id: "shortcuts", size: "lg", hidden: false }
                ]
            },
            ["shortcuts"]
        );
        expect(resolved.map((widget) => widget.id)).toEqual(["shortcuts"]);
    });

    it("puts a card nobody has arranged where the catalogue has it, not at the end", () => {
        // Somebody who only ever hid Usage, with Services (which ships before it)
        // and Tasks (after) never touched.
        const resolved = resolveOverviewLayout(
            { ...EMPTY_OVERVIEW_PREFERENCES, widgets: [{ id: "usage", size: "sm", hidden: true }] },
            ["services", "usage", "tasks"]
        );
        expect(resolved.map((widget) => widget.id)).toEqual(["services", "usage", "tasks"]);
    });

    it("draws the shipped layout for an account that has arranged nothing", () => {
        const resolved = resolveOverviewLayout(EMPTY_OVERVIEW_PREFERENCES, ALL);
        expect(resolved).toEqual([...DEFAULT_OVERVIEW_LAYOUT]);
    });

    it("survives a layout naming the same card twice", () => {
        const resolved = resolveOverviewLayout(
            {
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [
                    { id: "tasks", size: "sm", hidden: false },
                    { id: "tasks", size: "lg", hidden: true }
                ]
            },
            ["tasks"]
        );
        expect(resolved).toEqual([{ id: "tasks", size: "sm", hidden: false }]);
    });
});

describe("mergeRecentPlaces", () => {
    const place = (href: string, visitedAt: string) => ({ href, label: href, context: null, visitedAt });

    it("keeps one entry per page, at the time it was last opened", () => {
        const merged = mergeRecentPlaces(
            [place("/tasks", "2026-08-12T10:00:00.000Z")],
            [place("/tasks", "2026-08-11T10:00:00.000Z"), place("/drive", "2026-08-12T09:00:00.000Z")]
        );
        expect(merged.map((entry) => entry.href)).toEqual(["/tasks", "/drive"]);
        expect(merged[0]?.visitedAt).toBe("2026-08-12T10:00:00.000Z");
    });

    it("stops at the cap, newest kept", () => {
        const many = Array.from({ length: MAX_RECENT_PLACES + 5 }, (_, index) =>
            place(`/page-${index}`, `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`)
        );
        const merged = mergeRecentPlaces(many);
        expect(merged).toHaveLength(MAX_RECENT_PLACES);
        expect(merged[0]?.href).toBe(`/page-${many.length - 1}`);
    });
});
