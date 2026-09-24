/**
 * Where a "somebody is waiting" count is drawn, and how many things it is.
 *
 * Two rules that each went wrong once, kept together because both are about
 * one waiting thing being shown in one place and counted once:
 *
 * - **A count sits on the screen it is about.** Inside Management the rail's
 *   Overview entry shares the app's own address, so it wore the whole app's
 *   count - an update waiting showed on Overview rather than on "Update &
 *   settings", and a report on Overview rather than on Safety. Inside an app,
 *   each screen carries only its own; the app's total is for the entry that
 *   opens the app.
 * - **The tab icon counts a thing once.** An update waiting, and a report or a
 *   case to settle, each raise a notification as well as Management's count, so
 *   the bell and Management both had it and the tab icon added the two: one
 *   update read as two. What the bell already holds unread is taken off
 *   Management's share.
 *
 * Pure, so both rules can be asserted without a screen.
 */

/** Management's queue, as `admin-waiting` holds it. */
export interface AdminQueue {
    readonly reports: number;
    readonly cases: number;
    readonly update: boolean;
}

/** The notification each part of that queue is announced with. */
export const UPDATE_EVENT = "system.update";
export const SAFETY_EVENT = "admin.safety.case";

/** Management's own screens that carry a part of its count. */
const ADMIN_SCREEN_COUNT: Readonly<Record<string, (queue: AdminQueue) => number>> = {
    "/admin/settings": (queue) => (queue.update ? 1 : 0),
    "/admin/safety": (queue) => queue.reports + queue.cases
};

/** The Management app's id, as the app catalogue has it. */
const ADMIN_APP_ID = "admin";

/**
 * The count one rail entry wears.
 *
 * `inApp` is whether the rail is an app's own screens rather than the list of
 * apps. `appId` is the app an entry's address belongs to, when it belongs to one.
 */
export function railCount(input: {
    readonly href: string;
    readonly appId: string;
    readonly inApp: boolean;
    readonly waiting: Readonly<Record<string, number>>;
    readonly admin: AdminQueue;
}): number {
    if (!input.inApp) return input.waiting[input.appId] ?? 0;
    const screen = ADMIN_SCREEN_COUNT[input.href];
    if (screen) return screen(input.admin);
    // Management's Overview has the app's address and none of its queue: the
    // screens it is about carry that.
    if (input.appId === ADMIN_APP_ID) return 0;
    return input.waiting[input.appId] ?? 0;
}

/**
 * Everything waiting, as the one number the tab icon shows.
 *
 * `bell` is the notification feed; `apps` is each app's count, Management's
 * included. Management's share is reduced by the unread notifications that
 * announce the same things, never below what the bell does not already hold.
 */
export function tabWaiting(input: {
    readonly bell: readonly { readonly type: string; readonly read: boolean }[];
    readonly apps: Readonly<Record<string, number>>;
    readonly admin: AdminQueue;
}): number {
    const unreadOf = (type: string) =>
        input.bell.filter((row) => !row.read && row.type === type).length;
    const bellUnread = input.bell.filter((row) => !row.read).length;
    const apps = Object.values(input.apps).reduce((sum, count) => sum + count, 0);
    const overlap =
        Math.min(input.admin.update ? 1 : 0, unreadOf(UPDATE_EVENT)) +
        Math.min(input.admin.reports + input.admin.cases, unreadOf(SAFETY_EVENT));
    return bellUnread + apps - overlap;
}
