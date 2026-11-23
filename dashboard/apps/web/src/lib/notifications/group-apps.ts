/**
 * What each notification group is: one app's alerts, Polaris's own, or a
 * category that cuts across apps. Read by every screen that lists the groups
 * (Account > Notifications, the history filter, the webhook event picker) for
 * the mark it wears, and by the server for which groups an account sees.
 *
 * An app group is named through `aliasedAppId`, the same table every other
 * screen resolves an app's logo with, and it agrees with the app registry's
 * `notificationGroups` (the mute ownership) - `test/notifications/group-apps`
 * holds both to that, and fails when a group is added without a mark.
 *
 * Pure and free of UI imports, so the server page can filter with it.
 */

import { aliasedAppId } from "@/lib/app-aliases";
import { NOTIFICATION_GROUPS, type NotificationGroup } from "@polaris/core";

/** Groups that are not one app's alerts, and what each is drawn as. */
export const NON_APP_GROUPS = {
    // Updates, storage, integrations, announcements: Polaris itself.
    system: "polaris",
    // Sign-ins, sessions, keys, a domain's security, a vulnerable image: about
    // the account and the instance, raised by several apps at once.
    security: "security"
} as const satisfies Partial<Record<NotificationGroup, string>>;

export type NonAppGroup = keyof typeof NON_APP_GROUPS;

export type NotificationGroupMark =
    | { readonly kind: "app"; readonly appId: string }
    | { readonly kind: (typeof NON_APP_GROUPS)[NonAppGroup] };

/**
 * Groups shown whether or not the account can open their app: an automation's
 * alert step reaches the people and teams it names, who need not be able to
 * open Automations, and still need to be able to mute it.
 */
const SHOWN_TO_ANYONE: ReadonlySet<NotificationGroup> = new Set(["alerts"]);

function isNonApp(group: NotificationGroup): group is NonAppGroup {
    return Object.hasOwn(NON_APP_GROUPS, group);
}

/** The mark a group wears beside its name. */
export function notificationGroupMark(group: NotificationGroup): NotificationGroupMark {
    return isNonApp(group) ? { kind: NON_APP_GROUPS[group] } : { kind: "app", appId: aliasedAppId(group) };
}

/** The app whose access decides whether the account sees the group, or null
 *  for one every account sees. */
export function notificationGroupGate(group: NotificationGroup): string | null {
    if (isNonApp(group) || SHOWN_TO_ANYONE.has(group)) return null;
    return aliasedAppId(group);
}

/** The groups an account that can open `reachable` (app ids) sees, in order. */
export function visibleNotificationGroups(reachable: ReadonlySet<string>): NotificationGroup[] {
    return NOTIFICATION_GROUPS.filter((group) => {
        const gate = notificationGroupGate(group);
        return gate === null || reachable.has(gate);
    });
}
