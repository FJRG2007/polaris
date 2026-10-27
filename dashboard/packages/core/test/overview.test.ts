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
    moveOverviewCard,
    orderOverviewCards,
    overviewArranged,
    overviewPreferencesSchema,
    parseOverviewPreferences,
    rankOverviewLayout,
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
        const appWidget = {
            id: "card0001",
            app: "places",
            kind: "devices",
            size: "md" as const,
            targets: ["lamp"]
        };
        const stored = stringifyOverviewPreferences({
            widgets: [{ id: "usage", size: "lg", hidden: true }],
            appWidgets: [appWidget],
            shortcuts: [{ label: "Deploy", href: "/apps/deploy", context: "Apps" }],
            greeting: false
        });
        expect(parseOverviewPreferences(stored)).toEqual({
            widgets: [{ id: "usage", size: "lg", hidden: true }],
            // Cards saved before they could be hidden read as shown.
            appWidgets: [{ ...appWidget, hidden: false }],
            shortcuts: [{ label: "Deploy", href: "/apps/deploy", context: "Apps" }],
            greeting: false
        });
    });

    it("reads a layout saved before apps could add cards as having none", () => {
        const stored = JSON.stringify({
            widgets: [{ id: "usage", size: "lg", hidden: true }],
            shortcuts: [],
            greeting: true
        });
        expect(parseOverviewPreferences(stored).appWidgets).toEqual([]);
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
            overviewPreferencesSchema.safeParse({
                shortcuts: [{ label: "Elsewhere", href: "//example.com" }]
            }).success
        ).toBe(false);
        expect(
            overviewPreferencesSchema.safeParse({
                shortcuts: [{ label: "Deploy", href: "/apps/deploy" }]
            }).success
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
        // Somebody who only ever hid Services, with Usage (which ships before it)
        // and Tasks (after) never touched. Read from the shipped order rather than
        // hard-coded, so this keeps testing the rule when the order changes.
        const available = ["services", "usage", "tasks"] as const;
        const resolved = resolveOverviewLayout(
            {
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [{ id: "services", size: "sm", hidden: true }]
            },
            available
        );
        const catalogue = DEFAULT_OVERVIEW_LAYOUT.map((widget) => widget.id).filter((id) =>
            (available as readonly string[]).includes(id)
        );
        expect(resolved.map((widget) => widget.id)).toEqual(catalogue);
        expect(resolved.at(-1)?.id).not.toBe("usage");
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
    const place = (href: string, visitedAt: string) => ({
        href,
        label: href,
        context: null,
        visitedAt
    });

    it("keeps one entry per page, at the time it was last opened", () => {
        const merged = mergeRecentPlaces(
            [place("/tasks", "2026-08-12T10:00:00.000Z")],
            [
                place("/tasks", "2026-08-11T10:00:00.000Z"),
                place("/drive", "2026-08-12T09:00:00.000Z")
            ]
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

describe("cards with nothing to show", () => {
    const layout = resolveOverviewLayout(EMPTY_OVERVIEW_PREFERENCES, ALL);
    const ids = (list: readonly { id: string }[]) => list.map((widget) => widget.id);

    it("sink below the ones that do, each group keeping its order", () => {
        const ranked = rankOverviewLayout(layout, {
            arranged: false,
            placed: new Set(),
            empty: new Set(["shortcuts", "alarms"])
        });
        expect(ids(ranked).slice(-2)).toEqual(["shortcuts", "alarms"]);
        expect(ids(ranked).slice(0, -2)).toEqual(
            ids(layout).filter((id) => id !== "shortcuts" && id !== "alarms")
        );
    });

    it("keep their place while nothing is known", () => {
        const ranked = rankOverviewLayout(layout, {
            arranged: false,
            placed: new Set(),
            empty: new Set()
        });
        expect(ids(ranked)).toEqual(ids(layout));
    });

    it("never move a card the reader placed in an order of their own", () => {
        const preferences = {
            ...EMPTY_OVERVIEW_PREFERENCES,
            widgets: [
                { id: "alarms" as const, size: "sm" as const, hidden: false },
                { id: "shortcuts" as const, size: "lg" as const, hidden: false }
            ],
            arranged: true
        };
        const resolved = resolveOverviewLayout(preferences, ALL);
        const ranked = rankOverviewLayout(resolved, {
            arranged: overviewArranged(preferences),
            placed: new Set(["alarms", "shortcuts"]),
            empty: new Set(["alarms", "shortcuts", "games"])
        });
        // Both are empty, yet both stay where the reader put them.
        expect(ids(ranked).filter((id) => id === "alarms" || id === "shortcuts")).toEqual([
            "alarms",
            "shortcuts"
        ]);
        // A card they never placed still sinks when it is empty.
        expect(ids(ranked).at(-1)).toBe("games");
    });

    it("read an old layout that breaks the catalogue order as arranged by hand", () => {
        const widget = (id: (typeof ALL)[number]) => ({ id, size: "md" as const, hidden: false });
        expect(
            overviewArranged({
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [widget("apps"), widget("shortcuts")]
            })
        ).toBe(true);
        expect(
            overviewArranged({
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [widget("shortcuts"), widget("usage"), widget("apps")]
            })
        ).toBe(false);
        expect(overviewArranged(EMPTY_OVERVIEW_PREFERENCES)).toBe(false);
    });

    it("let a recorded answer win over the order it was saved in", () => {
        const widget = (id: (typeof ALL)[number]) => ({ id, size: "md" as const, hidden: false });
        expect(
            overviewArranged({
                ...EMPTY_OVERVIEW_PREFERENCES,
                widgets: [widget("apps"), widget("shortcuts")],
                arranged: false
            })
        ).toBe(false);
        expect(parseOverviewPreferences(JSON.stringify({ arranged: true })).arranged).toBe(true);
    });
});

describe("the one order both kinds of card share", () => {
    const builtIns = ["shortcuts", "usage", "services"] as const;
    const apps = ["app:card0001", "app:card0002"] as const;

    it("puts the apps' cards after the Overview's own until somebody arranges them", () => {
        expect(orderOverviewCards(builtIns, apps, undefined)).toEqual([
            "shortcuts",
            "usage",
            "services",
            "app:card0001",
            "app:card0002"
        ]);
    });

    it("keeps the order the reader arranged, across kinds", () => {
        const order = ["app:card0002", "usage", "shortcuts", "app:card0001", "services"] as const;
        expect(orderOverviewCards(builtIns, apps, order)).toEqual(order);
    });

    it("loses no card and draws none twice", () => {
        const order = ["usage", "app:card0001", "usage", "app:gone0000", "app:card0001"] as const;
        const drawn = orderOverviewCards(builtIns, apps, order);
        expect([...drawn].sort()).toEqual([...builtIns, ...apps].sort());
        // A new Overview card follows its neighbour; a new app card goes last.
        expect(drawn).toEqual(["shortcuts", "usage", "services", "app:card0001", "app:card0002"]);
        expect(orderOverviewCards(builtIns, apps, ["app:card0001", "services"])).toEqual([
            "shortcuts",
            "usage",
            "app:card0001",
            "services",
            "app:card0002"
        ]);
    });

    it("drops one card where another is, whichever kind either is", () => {
        const keys = orderOverviewCards(builtIns, apps, undefined);
        expect(moveOverviewCard(keys, "app:card0002", "shortcuts")).toEqual([
            "app:card0002",
            "shortcuts",
            "usage",
            "services",
            "app:card0001"
        ]);
        expect(moveOverviewCard(keys, "usage", "app:card0002")).toEqual([
            "shortcuts",
            "services",
            "app:card0001",
            "app:card0002",
            "usage"
        ]);
        expect(moveOverviewCard(keys, "usage", "usage")).toEqual(keys);
        expect(moveOverviewCard(keys, "app:nope0000", "usage")).toEqual(keys);
    });

    it("stores app cards and the order, and refuses keys that name nothing", () => {
        const parsed = overviewPreferencesSchema.parse({
            order: ["usage", "app:card0001"],
            appWidgets: [{ id: "card0001", app: "places", kind: "devices", hidden: true }]
        });
        expect(parsed.order).toEqual(["usage", "app:card0001"]);
        expect(parsed.appWidgets[0]?.hidden).toBe(true);
        expect(overviewPreferencesSchema.parse({}).order).toBeUndefined();
        for (const bad of [["nope"], ["app:../x"], ["app:"], [42]]) {
            expect(overviewPreferencesSchema.safeParse({ order: bad }).success).toBe(false);
        }
    });
});
