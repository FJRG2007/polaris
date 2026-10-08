/**
 * What the app menu lists under its grid: the things each app has waiting, and
 * how somebody says they have dealt with one.
 *
 * Drawn the way a notification centre groups by app (macOS, Windows, Android):
 * one group per app with its icon, name and count, the newest few entries in
 * it, each one opening what it is about and each one with its own "mark read",
 * and one "mark all read" for the group.
 *
 * "Read" here means what the app itself means by it, never a second flag only
 * the menu knows about. A conversation marked read in the menu is read in Chat,
 * a message marked read is read in Mail (and on the mail server). Management has
 * no "read": its entries are work - a report nobody settled, an update nobody
 * installed - and they stay in Management until somebody does it. What the menu
 * can say there is "I have seen this", which is what the badge counts, so it is
 * stored exactly where a visit to the screen stores it (`badge-seen`). A Google
 * API switched off is a fault rather than news, and is never dismissed: it is
 * listed with the way to the screen that fixes it.
 *
 * Pure and safe in the browser: the shapes the route answers with and the
 * inputs the actions accept, so both ends validate against one schema.
 */

import { z } from "zod";

/** The apps the menu lists entries for. Each counts on its badge already. */
export const LAUNCHER_WAITING_APPS = ["chat", "mail", "admin"] as const;

export type LauncherWaitingApp = (typeof LAUNCHER_WAITING_APPS)[number];

/** How many entries a group lists. The rest are behind "Open", in the app. */
export const LAUNCHER_ITEMS_PER_APP = 5;

/** The Management entries, which are kinds of work rather than rows. */
export const ADMIN_ITEM_IDS = ["reports", "cases", "update", "apis"] as const;

export type AdminItemId = (typeof ADMIN_ITEM_IDS)[number];

/** The Management entries the menu can mark seen. APIs are a fault. */
export const DISMISSABLE_ADMIN_ITEMS: readonly AdminItemId[] = ["reports", "cases", "update"];

const itemSchema = z.object({
    /** The conversation, the mail thread, or the Management entry. */
    id: z.string().min(1).max(64),
    /** Who or what it is: the conversation's name, the sender. For Management,
     *  empty - the words come from the catalogue by `id`. */
    title: z.string().max(300),
    /** The subject of a message; empty where there is none. */
    detail: z.string().max(300),
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

/** One entry marked read, or every entry of one app. */
export const markLauncherReadSchema = z.discriminatedUnion("scope", [
    z.object({
        scope: z.literal("item"),
        app: z.enum(LAUNCHER_WAITING_APPS),
        id: z.string().trim().min(1).max(64)
    }),
    z.object({ scope: z.literal("app"), app: z.enum(LAUNCHER_WAITING_APPS) })
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

/** How much a mark takes off an app's badge: the difference between the group
 *  before and after. Negative, or zero when nothing moved. */
export function badgeDelta(
    before: LauncherWaiting,
    after: LauncherWaiting,
    app: LauncherWaitingApp
): number {
    const total = (waiting: LauncherWaiting) =>
        waiting.groups.find((group) => group.app === app)?.total ?? 0;
    return total(after) - total(before);
}
