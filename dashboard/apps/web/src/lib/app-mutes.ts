/**
 * Muting a whole app from its right click: what it holds back, whether it is
 * muted, and the change a mute makes.
 *
 * Stored in the account's notification holds, the same as a mute set in
 * Account > Notifications, so both screens show and lift the same thing and
 * dispatch enforces it with no second rule. An app maps to the notification
 * groups the registry gives it (`notificationGroups` in `lib/apps`), plus a
 * hold of its own when its alerts are not catalogue events - Chat. An app with
 * neither has nothing to mute and is not offered the option.
 *
 * Pure, so the server action, the menu and the tests read one answer.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { POLARIS_APPS } from "@/lib/apps";
import { appIdSchema } from "@/lib/app-locks";

const APP_HOLDS: readonly string[] = core.APP_HOLD_IDS;

/** The holds a mute on this app sets, or none for an app with no alerts. */
export function appMuteTargets(appId: string): core.HoldTarget[] {
    const own: core.HoldTarget[] = APP_HOLDS.includes(appId)
        ? [{ kind: "app", id: appId as core.AppHoldId }]
        : [];
    const groups = POLARIS_APPS.find((app) => app.id === appId)?.notificationGroups ?? [];
    return [...own, ...groups.map((id): core.HoldTarget => ({ kind: "group", id }))];
}

/** Whether the app has any alerts a mute could hold back. */
export function mutableApp(appId: string): boolean {
    return appMuteTargets(appId).length > 0;
}

export interface AppMuteState {
    readonly muted: boolean;
    /** When it lifts by itself: the earliest end among its holds, or null for
     *  one that lasts until it is turned back on. */
    readonly until: string | null;
}

/** Whether every hold the app owns is muted at `now`. One muted on its own in
 *  Account > Notifications leaves the app unmuted, so the menu still offers it. */
export function appMuteState(
    holds: core.NotificationHolds,
    appId: string,
    now: Date
): AppMuteState {
    const targets = appMuteTargets(appId);
    const mutes = targets.map((target) => holds.mutes[core.holdKey(target)]);
    if (targets.length === 0 || !mutes.every((mute) => core.muteActive(mute, now))) {
        return { muted: false, until: null };
    }
    const ends = mutes.flatMap((mute) => (mute?.until ? [mute.until] : []));
    const until = ends.reduce<string | null>(
        (soonest, end) =>
            soonest === null || new Date(end).getTime() < new Date(soonest).getTime() ? end : soonest,
        null
    );
    return { muted: true, until };
}

/** The holds with the app muted for `duration` from `now`, or unmuted for null.
 *  The end is always worked out here, never taken from a browser. */
export function applyAppMute(
    holds: core.NotificationHolds,
    appId: string,
    duration: core.NotificationMuteDuration | null,
    now: Date
): core.NotificationHolds {
    const mutes = { ...holds.mutes };
    const until = duration === null ? null : core.muteUntil(duration, now);
    for (const target of appMuteTargets(appId)) {
        const key = core.holdKey(target);
        if (duration === null) delete mutes[key];
        else mutes[key] = { until };
    }
    return { ...holds, mutes };
}

/** What the menu sends: the app and how long, never an end time. */
export const setAppMuteSchema = z
    .object({
        appId: appIdSchema,
        duration: z.enum(core.NOTIFICATION_MUTE_DURATIONS).nullable()
    })
    .strict();
