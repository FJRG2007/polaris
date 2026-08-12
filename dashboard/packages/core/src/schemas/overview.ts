/**
 * The Overview: the screen somebody lands on, and what they have made of it.
 *
 * Two things are stored per account and both are the reader's, not the
 * deployment's: which cards the grid draws and in what order and size, and the
 * links they pinned to the top of it. Everything else on the screen is derived
 * from what they can already reach, so nothing here decides access - a stored
 * card whose permission the account does not hold is dropped when the layout is
 * resolved, and a pinned link is only ever a path inside Polaris.
 *
 * A saved layout holds only the cards the account has actually touched. A card
 * added to Polaris later is therefore not absent from an existing layout, it is
 * simply not mentioned in it, and the resolver puts it where the catalogue says
 * it belongs - the same reason a newly added notification event arrives unmuted
 * rather than silently off for everybody who saved their preferences first.
 */

import { z } from "zod";
import { internalPath } from "./search.js";

/**
 * The cards the grid can draw. Presentation (name, icon, the component itself)
 * lives with the dashboard; what is here is the vocabulary the stored layout is
 * written in, so a blob from the database can be validated without importing any
 * of it.
 */
export const OVERVIEW_WIDGET_IDS = [
    "shortcuts",
    "services",
    "usage",
    "notifications",
    "recent",
    "tasks",
    "alarms",
    "storage",
    "apps",
    "sessions",
    "activity",
    "games"
] as const;

export type OverviewWidgetId = (typeof OVERVIEW_WIDGET_IDS)[number];

/**
 * How wide a card is drawn: narrow, medium, wide. What each is worth in columns
 * is the grid's business and changes with the screen; what is stored is only
 * which of the three it is. Not free-form column counts - a grid whose cards can
 * be any width is a grid that can be arranged into something unreadable, and
 * three sizes cover every card there is.
 */
export const OVERVIEW_WIDGET_SIZES = ["sm", "md", "lg"] as const;

export type OverviewWidgetSize = (typeof OVERVIEW_WIDGET_SIZES)[number];

/** Pinned links. Past this the row stops being the handful you recognize. */
export const MAX_OVERVIEW_SHORTCUTS = 12;

/** Pages remembered as recently visited, per browser. */
export const MAX_RECENT_PLACES = 12;

export const overviewWidgetSchema = z.object({
    id: z.enum(OVERVIEW_WIDGET_IDS),
    size: z.enum(OVERVIEW_WIDGET_SIZES).default("md"),
    /** Turned off by the reader. Kept in the list rather than removed from it, so
     *  turning it back on returns it to where it was rather than to the end. */
    hidden: z.boolean().default(false)
});

export type OverviewWidgetPreference = z.infer<typeof overviewWidgetSchema>;

export const overviewShortcutSchema = z.object({
    label: z.string().trim().min(1).max(80),
    href: internalPath,
    /** A hint at what it opens, shown under the label. */
    context: z.string().trim().max(120).nullable().default(null)
});

export type OverviewShortcut = z.infer<typeof overviewShortcutSchema>;

export const overviewPreferencesSchema = z.object({
    widgets: z
        .array(overviewWidgetSchema)
        .max(OVERVIEW_WIDGET_IDS.length * 2)
        .default([]),
    shortcuts: z.array(overviewShortcutSchema).max(MAX_OVERVIEW_SHORTCUTS).default([]),
    /** The line above the grid. Off for somebody who would rather not be greeted
     *  by their own software every morning. */
    greeting: z.boolean().default(true)
});

export type OverviewPreferences = z.infer<typeof overviewPreferencesSchema>;

export const EMPTY_OVERVIEW_PREFERENCES: OverviewPreferences = {
    widgets: [],
    shortcuts: [],
    greeting: true
};

/**
 * The layout an account starts on, before it has chosen anything.
 *
 * The order is what somebody arriving wants to know, in that order: what they
 * pinned, what is running, what it is costing, what happened while they were
 * away. Cards further down are the ones you look at when you have already read
 * the top of the screen.
 *
 * The sizes are mixed rather than uniform so the grid packs: a wide card is
 * followed by something narrow enough to sit beside it. How many columns there
 * are to pack is not known here - it follows the width the grid is given - and
 * what each account sees is narrowed by its permissions, so no fixed set of
 * sizes can tile every grid. The grid backfills what is left (see its dense
 * flow); these are what give it something to backfill with, rather than a row of
 * identical halves.
 *
 * Every card is on. A landing screen that hides half of itself until somebody
 * finds the customize button is a landing screen that teaches nobody what is
 * there.
 */
export const DEFAULT_OVERVIEW_LAYOUT: readonly OverviewWidgetPreference[] = [
    { id: "shortcuts", size: "lg", hidden: false },
    { id: "usage", size: "sm", hidden: false },
    { id: "services", size: "md", hidden: false },
    { id: "notifications", size: "md", hidden: false },
    { id: "tasks", size: "sm", hidden: false },
    { id: "alarms", size: "sm", hidden: false },
    { id: "storage", size: "md", hidden: false },
    // Between the infrastructure cards and the account's own: it belongs with what
    // is running, and it is only ever on the grid of somebody who runs one.
    { id: "games", size: "md", hidden: false },
    { id: "activity", size: "md", hidden: false },
    { id: "sessions", size: "md", hidden: false },
    { id: "recent", size: "md", hidden: false },
    { id: "apps", size: "md", hidden: false }
];

/** Read a stored blob back. Anything unparseable is an empty preference rather
 *  than an error: a layout is not worth failing a page load over. */
export function parseOverviewPreferences(raw: string | null | undefined): OverviewPreferences {
    if (!raw) return EMPTY_OVERVIEW_PREFERENCES;
    try {
        const parsed = overviewPreferencesSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : EMPTY_OVERVIEW_PREFERENCES;
    } catch {
        return EMPTY_OVERVIEW_PREFERENCES;
    }
}

export function stringifyOverviewPreferences(preferences: OverviewPreferences): string {
    return JSON.stringify(preferences);
}

/**
 * The cards to draw, in order, for one reader.
 *
 * `available` is what this account may see at all, decided by permissions on the
 * server. It is applied last and unconditionally: a card can be in a saved
 * layout because the account once held the permission, or because somebody wrote
 * the blob by hand, and neither is a reason to draw it.
 *
 * A card the layout does not mention keeps its catalogue position rather than
 * being appended, so an account that only ever hid one card does not find the
 * next release's card at the bottom of a grid it never arranged.
 */
export function resolveOverviewLayout(
    preferences: OverviewPreferences,
    available: readonly OverviewWidgetId[]
): OverviewWidgetPreference[] {
    const allowed = new Set(available);
    const saved = new Map(preferences.widgets.map((widget) => [widget.id, widget]));
    const ordered: OverviewWidgetPreference[] = [];

    // The reader's own order first, then whatever the catalogue has that they
    // have never expressed an opinion about, in its own order. A card named twice
    // in a stored layout is kept once, at the first place it is named.
    for (const widget of preferences.widgets) {
        if (!allowed.has(widget.id)) continue;
        if (ordered.some((held) => held.id === widget.id)) continue;
        ordered.push(widget);
    }
    for (const [at, fallback] of DEFAULT_OVERVIEW_LAYOUT.entries()) {
        if (!allowed.has(fallback.id) || saved.has(fallback.id)) continue;
        const on = (id: OverviewWidgetId) => ordered.some((held) => held.id === id);
        // Sit it next to the neighbour it ships beside: after the nearest one
        // above it that is on screen, or failing that before the nearest one
        // below - a card that ships first must not fall to the bottom of the grid
        // just because everything above it happens to be hidden. With neither on
        // screen the end is as good a place as any.
        const above = DEFAULT_OVERVIEW_LAYOUT.slice(0, at)
            .reverse()
            .find((entry) => on(entry.id));
        const below = above
            ? undefined
            : DEFAULT_OVERVIEW_LAYOUT.slice(at + 1).find((entry) => on(entry.id));
        const index = above
            ? ordered.findIndex((held) => held.id === above.id) + 1
            : below
              ? ordered.findIndex((held) => held.id === below.id)
              : ordered.length;
        ordered.splice(index, 0, { ...fallback });
    }
    return ordered;
}

/** A page somebody opened, as the browser remembers it. */
export const recentPlaceSchema = z.object({
    href: internalPath,
    label: z.string().trim().min(1).max(120),
    /** The app or section it belongs to, for the second line. */
    context: z.string().trim().max(120).nullable().default(null)
});

export type RecentPlaceInput = z.infer<typeof recentPlaceSchema>;

export interface RecentPlace extends RecentPlaceInput {
    /** When it was last opened, ISO 8601. */
    readonly visitedAt: string;
}

/** Newest first, one entry per path, capped. */
export function mergeRecentPlaces(...lists: readonly (readonly RecentPlace[])[]): RecentPlace[] {
    const byHref = new Map<string, RecentPlace>();
    for (const place of lists.flat()) {
        const held = byHref.get(place.href);
        if (!held || held.visitedAt < place.visitedAt) byHref.set(place.href, place);
    }
    return [...byHref.values()]
        .sort((left, right) => right.visitedAt.localeCompare(left.visitedAt))
        .slice(0, MAX_RECENT_PLACES);
}
