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

/**
 * The holds with one target muted for `duration` from `now`, or unmuted for
 * null. A new length keeps whether the mute holds mentions too, so muting again
 * from any screen does not quietly let them back through. The one way every
 * screen sets a mute.
 */
export function applyHoldMute(
    holds: core.NotificationHolds,
    target: core.HoldTarget,
    duration: core.NotificationMuteDuration | null,
    now: Date
): core.NotificationHolds {
    const key = core.holdKey(target);
    const mutes = { ...holds.mutes };
    if (duration === null) delete mutes[key];
    else {
        const until = core.muteUntil(duration, now);
        mutes[key] = mutes[key]?.mentions ? { until, mentions: true } : { until };
    }
    return { ...holds, mutes };
}

/** The holds with the app muted for `duration` from `now`, or unmuted for null.
 *  The end is always worked out here, never taken from a browser. */
export function applyAppMute(
    holds: core.NotificationHolds,
    appId: string,
    duration: core.NotificationMuteDuration | null,
    now: Date
): core.NotificationHolds {
    return appMuteTargets(appId).reduce(
        (next, target) => applyHoldMute(next, target, duration, now),
        holds
    );
}

/** Whether the app's mute can be set to hold back a mention of the reader too:
 *  only an app with a hold of its own, whose alerts know who they name. */
export function mentionsMutable(appId: string): boolean {
    return APP_HOLDS.includes(appId);
}

/** Whether the app is muted at `now` and that mute holds back mentions too. */
export function appMutesMentions(
    holds: core.NotificationHolds,
    appId: string,
    now: Date
): boolean {
    return mentionsMutable(appId) && core.appHoldMutesMentions(holds, appId as core.AppHoldId, now);
}

/** The holds with the app's mute holding back mentions too, or letting them
 *  through. Only a mute in force changes: there is nothing to set otherwise. */
export function applyAppMuteMentions(
    holds: core.NotificationHolds,
    appId: string,
    on: boolean,
    now: Date
): core.NotificationHolds {
    if (!mentionsMutable(appId)) return holds;
    const key = core.holdKey({ kind: "app", id: appId as core.AppHoldId });
    const mute = holds.mutes[key];
    if (!mute || !core.muteActive(mute, now)) return holds;
    const next = on ? { until: mute.until, mentions: true } : { until: mute.until };
    return { ...holds, mutes: { ...holds.mutes, [key]: next } };
}

/** What the menu sends to hold mentions back too: the app and yes or no. */
export const setAppMuteMentionsSchema = z
    .object({ appId: appIdSchema, on: z.boolean() })
    .strict();

/** What the menu sends: the app and how long, never an end time. */
export const setAppMuteSchema = z
    .object({
        appId: appIdSchema,
        duration: z.enum(core.NOTIFICATION_MUTE_DURATIONS).nullable()
    })
    .strict();
