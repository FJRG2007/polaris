/**
 * What each app has waiting, as the app menu knows it, and how somebody says
 * they have dealt with it from there.
 *
 * The menu lists apps and nothing else: the count is on each tile, and a tile
 * with something it may dismiss offers "mark read" for the whole app, with one
 * "mark everything read" at the foot. The entries below are what the route
 * answers with, so the menu knows which tiles may be marked and by how much a
 * mark moves each badge.
 *
 * Marking an app read here is what it is on a phone's home screen: the badge
 * goes - on the tile, the rail, the switcher's dot and the tab icon - and
 * nothing inside the app changes. The conversations in Chat and the messages in
 * Mail are still unread when the app is opened, and stay so until they are
 * opened there. The menu keeps a moment per app (`badge-seen`) and the badge
 * counts only what arrived after it, so anything new raises it again.
 * Management has no "read": its entries are work - a report nobody settled, an
 * update nobody installed - and they stay in Management until somebody does it.
 * What the menu can say there is "I have seen this", which is what the badge
 * counts, so it is stored exactly where a visit to the screen stores it
 * (`badge-seen`). A Google API switched off is a fault rather than news, and is
 * never dismissed: it is listed with the way to the screen that fixes it.
 *
 * Pure and safe in the browser: the shapes the route answers with and the
 * inputs the actions accept, so both ends validate against one schema.
 */

import { z } from "zod";

/** Every app that counts on its badge (`useServerUnread` is typed by this
 *  list, so an app cannot start counting without being markable here), and so
 *  every app the menu lists entries for and marks read. */
export const LAUNCHER_WAITING_APPS = ["chat", "mail", "admin"] as const;

export type LauncherWaitingApp = (typeof LAUNCHER_WAITING_APPS)[number];

/** How many entries a group lists. The rest are behind "Open", in the app. */
export const LAUNCHER_ITEMS_PER_APP = 5;

/** The Management entries, which are kinds of work rather than rows. */
export const ADMIN_ITEM_IDS = ["reports", "cases", "update", "apis"] as const;

export type AdminItemId = (typeof ADMIN_ITEM_IDS)[number];

/** The Management entries the menu can mark seen. A switched-off API seen
 *  stays off - Integrations still says so - but stops counting until another
 *  one goes off. */
export const DISMISSABLE_ADMIN_ITEMS: readonly AdminItemId[] = [
    "reports",
    "cases",
    "update",
    "apis"
];

/** The longest title or detail an entry carries. A row truncates long before
 *  it, and the full text is in what the entry opens. */
export const LAUNCHER_TEXT_MAX = 300;

/** A title or detail cut to what an entry carries, so one long subject cannot
 *  fail the whole answer. Never ends on half of a character. */
export function clipText(text: string): string {
    if (text.length <= LAUNCHER_TEXT_MAX) return text;
    const cut = text.slice(0, LAUNCHER_TEXT_MAX);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const itemSchema = z.object({
    /** The conversation, the mail thread, or the Management entry. */
    id: z.string().min(1).max(64),
    /** Who or what it is: the conversation's name, the sender. For Management,
     *  empty - the words come from the catalogue by `id`. */
    title: z.string().max(LAUNCHER_TEXT_MAX),
    /** The subject of a message; empty where there is none. */
    detail: z.string().max(LAUNCHER_TEXT_MAX),
    href: z.string().startsWith("/").max(300),
    /** How many are waiting in it: messages in a conversation, reports. */
    count: z.number().int().nonnegative(),
    /** Whether the menu may mark it read or seen. */
    dismissable: z.boolean()
});

export type LauncherWaitingItem = z.infer<typeof itemSchema>;

const groupSchema = z.object({
    app: z.enum(LAUNCHER_WAITING_APPS),
    /** Everything waiting in the app - the badge's number, not the list's. */
    total: z.number().int().nonnegative(),
    items: z.array(itemSchema).max(LAUNCHER_ITEMS_PER_APP)
});

export type LauncherWaitingGroup = z.infer<typeof groupSchema>;

export const launcherWaitingSchema = z.object({ groups: z.array(groupSchema) });

export type LauncherWaiting = z.infer<typeof launcherWaitingSchema>;

/** One entry marked read, every entry of one app, or everything in every app
 *  this reader can reach. */
export const markLauncherReadSchema = z.discriminatedUnion("scope", [
    z.object({
        scope: z.literal("item"),
        app: z.enum(LAUNCHER_WAITING_APPS),
        id: z.string().trim().min(1).max(64)
    }),
    z.object({ scope: z.literal("app"), app: z.enum(LAUNCHER_WAITING_APPS) }),
    z.object({ scope: z.literal("all") })
]);

export type MarkLauncherRead = z.infer<typeof markLauncherReadSchema>;

/** The menu after an entry is marked read, before the server has answered: the
 *  entry gone and its count off the group's total. A group left with nothing
 *  waiting goes too. */
export function withoutItem(
    waiting: LauncherWaiting,
    app: LauncherWaitingApp,
    id: string
): LauncherWaiting {
    return {
        groups: waiting.groups.flatMap((group) => {
            if (group.app !== app) return [group];
            const gone = group.items.find((item) => item.id === id);
            if (!gone) return [group];
            const total = Math.max(0, group.total - gone.count);
            const items = group.items.filter((item) => item !== gone);
            return total === 0 && items.length === 0 ? [] : [{ ...group, total, items }];
        })
    };
}

/** The menu after every entry of an app is marked read: only what cannot be
 *  dismissed is left, and the group goes if that is nothing. */
export function withoutApp(waiting: LauncherWaiting, app: LauncherWaitingApp): LauncherWaiting {
    return {
        groups: waiting.groups.flatMap((group) => {
            if (group.app !== app) return [group];
            const items = group.items.filter((item) => !item.dismissable);
            const total = items.reduce((sum, item) => sum + item.count, 0);
            return items.length === 0 ? [] : [{ ...group, total, items }];
        })
    };
}

/** The menu after everything is marked read: only what cannot be dismissed. */
export function withoutAll(waiting: LauncherWaiting): LauncherWaiting {
    return LAUNCHER_WAITING_APPS.reduce((left, app) => withoutApp(left, app), waiting);
}

/** What a mark of an app leaves on its badge: the entries the route listed that
 *  no mark dismisses. Zero before the route has answered, and for every app
 *  whose entries are all dismissable. */
export function undismissable(waiting: LauncherWaiting | null, app: LauncherWaitingApp): number {
    const group = waiting?.groups.find((one) => one.app === app);
    return (group?.items ?? [])
        .filter((item) => !item.dismissable)
        .reduce((sum, item) => sum + item.count, 0);
}

/**
 * The apps a tile, a rail row and a right click offer "mark read" on: every app
 * whose badge is up, from the first paint. The badge is what the mark is about,
 * so it alone decides - an answer from the route that is late, or never comes,
 * cannot take the mark away.
 *
 * The route only refines: an app whose listed entries are all faults no mark
 * dismisses - a Google API switched off, while that is undismissable - is left
 * without one, since pressing it would change nothing.
 */
export function markableApps(
    unread: Readonly<Record<string, number>>,
    waiting: LauncherWaiting | null
): Set<LauncherWaitingApp> {
    const found = new Set<LauncherWaitingApp>();
    for (const app of LAUNCHER_WAITING_APPS) {
        if ((unread[app] ?? 0) <= 0) continue;
        const group = waiting?.groups.find((one) => one.app === app);
        const onlyFaults =
            !!group && group.items.length > 0 && group.items.every((item) => !item.dismissable);
        if (!onlyFaults) found.add(app);
    }
    return found;
}
