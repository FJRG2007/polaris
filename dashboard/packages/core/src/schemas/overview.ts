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
    "games",
    "calendar",
    "dnsBlocker"
] as const;

export type OverviewWidgetId = (typeof OVERVIEW_WIDGET_IDS)[number];

/**
 * How wide a card is drawn: narrow, medium, wide, widest. What each is worth in
 * columns is the grid's business and changes with the screen; what is stored is
 * only which of the four it is. Not free-form column counts - a grid whose cards
 * can be any width is a grid that can be arranged into something unreadable.
 *
 * The widest step is for the cards that are a list rather than a figure: five
 * rows of task names, or of pages somebody has been to, are all title and no
 * room, and the width they were capped at was the one the names needed.
 */
export const OVERVIEW_WIDGET_SIZES = ["sm", "md", "lg", "xl"] as const;

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

/** Cards an installed app can add, per account. Past this the Overview is a
 *  second app rather than a landing screen. */
export const MAX_APP_WIDGETS = 12;

/** Things one app card watches - devices, servers. A card for twenty of them is
 *  a list screen, which the app already has. */
export const MAX_APP_WIDGET_TARGETS = 12;

/** An app's id or a widget kind: what the catalogue and the app spell them as. */
const appSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/**
 * A card an installed app contributes, as somebody added it.
 *
 * Which app and which of its kinds, how wide, and what it watches - the ids of
 * the things the reader picked, in the app's own terms. Only ids: what each one
 * shows, and whether the reader may still see or operate it, is the app's to
 * answer every time the card is drawn, never something stored here.
 */
export const appWidgetSchema = z.object({
    id: z.string().regex(/^[a-z0-9]{8,32}$/),
    app: appSlug,
    kind: appSlug,
    size: z.enum(OVERVIEW_WIDGET_SIZES).default("md"),
    targets: z.array(z.string().trim().min(1).max(64)).max(MAX_APP_WIDGET_TARGETS).default([]),
    /** Turned off by the reader, like an Overview card: kept, with what it
     *  watches, so turning it back on returns it as it was. */
    hidden: z.boolean().default(false)
});

export type AppWidgetPreference = z.infer<typeof appWidgetSchema>;

/**
 * A card's place in the Overview's one order: an Overview card by its own id, an
 * app's card as `app:` and the card's id. Both kinds are arranged together, so
 * the order cannot be written in either list alone.
 */
export type OverviewCardKey = OverviewWidgetId | `app:${string}`;

export function appCardKey(id: string): `app:${string}` {
    return `app:${id}`;
}

export const overviewCardKeySchema = z.union([
    z.enum(OVERVIEW_WIDGET_IDS),
    z.custom<`app:${string}`>(
        (value) => typeof value === "string" && /^app:[a-z0-9]{8,32}$/.test(value)
    )
]);

export const overviewPreferencesSchema = z.object({
    widgets: z
        .array(overviewWidgetSchema)
        .max(OVERVIEW_WIDGET_IDS.length * 2)
        .default([]),
    /** The installed apps' cards. Where each is drawn among the Overview's own
     *  is `order`'s; without one they follow them, in this order. Absent from
     *  every layout saved before apps could add cards, which reads as none. */
    appWidgets: z.array(appWidgetSchema).max(MAX_APP_WIDGETS).default([]),
    /** Every card, both kinds, in the order the reader put them in (see
     *  `orderOverviewCards`). Absent until they first move a card after apps
     *  could add them, which reads as the Overview's own cards first and the
     *  apps' after, in their own order - where they always were. */
    order: z
        .array(overviewCardKeySchema)
        .max((OVERVIEW_WIDGET_IDS.length + MAX_APP_WIDGETS) * 2)
        .optional(),
    shortcuts: z.array(overviewShortcutSchema).max(MAX_OVERVIEW_SHORTCUTS).default([]),
    /** The line above the grid. Off for somebody who would rather not be greeted
     *  by their own software every morning. */
    greeting: z.boolean().default(true),
    /** Whether the reader has put the cards in an order of their own. Until they
     *  have, cards with nothing to show sink below the ones that do (see
     *  `rankOverviewLayout`). Absent from layouts saved before this was recorded,
     *  where it is read off the stored order instead (`overviewArranged`). */
    arranged: z.boolean().optional()
});

export type OverviewPreferences = z.infer<typeof overviewPreferencesSchema>;

export const EMPTY_OVERVIEW_PREFERENCES: OverviewPreferences = {
    widgets: [],
    appWidgets: [],
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
    // Beside the work: what is next in somebody's day. Only on the grid of an
    // instance that installed the Calendar.
    { id: "calendar", size: "md", hidden: false },
    { id: "alarms", size: "sm", hidden: false },
    { id: "storage", size: "md", hidden: false },
    // Between the infrastructure cards and the account's own: it belongs with what
    // is running, and it is only ever on the grid of somebody who runs one.
    { id: "games", size: "md", hidden: false },
    // The network's ad blocker, beside the other things this instance runs. Only
    // on the grid of an administrator of an instance that installed it.
    { id: "dnsBlocker", size: "md", hidden: false },
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

/**
 * Whether the stored order is one the reader chose.
 *
 * Recorded since cards started sinking when empty. A layout saved before that
 * says nothing, so its order is the evidence: a list that still follows the
 * catalogue's order was only ever saved because something else changed (a size,
 * a hidden card), while one that breaks it was rearranged by hand.
 */
export function overviewArranged(preferences: OverviewPreferences): boolean {
    if (preferences.arranged !== undefined) return preferences.arranged;
    const rank = new Map(DEFAULT_OVERVIEW_LAYOUT.map((widget, at) => [widget.id, at]));
    let last = -1;
    for (const widget of preferences.widgets) {
        const at = rank.get(widget.id);
        if (at === undefined) continue;
        if (at < last) return true;
        last = at;
    }
    return false;
}

/**
 * The resolved layout with the cards that have nothing to show moved after the
 * ones that do, keeping each group in its own order.
 *
 * The reader's own order always wins: once they have arranged the grid, only a
 * card they never placed (one added to Polaris since) is moved, and only when it
 * is empty. A card whose emptiness is not known yet is not in `empty`, so it
 * keeps its place.
 */
export function rankOverviewLayout(
    layout: readonly OverviewWidgetPreference[],
    options: {
        arranged: boolean;
        /** The cards the stored layout names. */
        placed: ReadonlySet<OverviewWidgetId>;
        empty: ReadonlySet<OverviewWidgetId>;
    }
): OverviewWidgetPreference[] {
    const sinks = (widget: OverviewWidgetPreference): boolean =>
        options.empty.has(widget.id) && (!options.arranged || !options.placed.has(widget.id));
    return [...layout.filter((widget) => !sinks(widget)), ...layout.filter(sinks)];
}

/**
 * Every card on the grid, both kinds, in one order.
 *
 * `builtIns` is the Overview's own cards as resolved and ranked, `apps` the apps'
 * cards in their stored order, and `order` what the reader arranged. Without an
 * order - every layout saved before the two kinds could be arranged together -
 * the apps' cards follow the Overview's own, which is where they were drawn.
 *
 * A key in the order that names no card here is skipped: the card was removed,
 * or is not drawn for this reader right now. A card the order does not name yet
 * is never lost: an Overview card added to the catalogue since sits after the
 * one it follows in its own order (first, when nothing before it is placed), and
 * an app card added since goes at the end, where it was put.
 */
export function orderOverviewCards(
    builtIns: readonly OverviewCardKey[],
    apps: readonly OverviewCardKey[],
    order: readonly OverviewCardKey[] | undefined
): OverviewCardKey[] {
    if (!order) return [...new Set([...builtIns, ...apps])];
    const present = new Set<OverviewCardKey>([...builtIns, ...apps]);
    const ordered: OverviewCardKey[] = [];
    const held = new Set<OverviewCardKey>();
    const place = (key: OverviewCardKey, at: number): void => {
        ordered.splice(at, 0, key);
        held.add(key);
    };
    for (const key of order) {
        if (present.has(key) && !held.has(key)) place(key, ordered.length);
    }
    for (const [at, key] of builtIns.entries()) {
        if (held.has(key)) continue;
        const before = builtIns
            .slice(0, at)
            .reverse()
            .find((other) => held.has(other));
        place(key, before ? ordered.indexOf(before) + 1 : 0);
    }
    for (const key of apps) if (!held.has(key)) place(key, ordered.length);
    return ordered;
}

/** One card put where another one is, whichever kind either is. Unchanged when
 *  either is not in the order or they are the same card. */
export function moveOverviewCard(
    keys: readonly OverviewCardKey[],
    key: OverviewCardKey,
    target: OverviewCardKey
): OverviewCardKey[] {
    const from = keys.indexOf(key);
    const to = keys.indexOf(target);
    if (from < 0 || to < 0 || from === to) return [...keys];
    const next = [...keys];
    next.splice(from, 1);
    next.splice(to, 0, key);
    return next;
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
