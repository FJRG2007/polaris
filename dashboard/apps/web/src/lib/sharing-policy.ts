/**
 * What this instance lets people hand out to each other.
 *
 * One stored setting rather than three, because they are read together: a screen
 * deciding whether to offer "Give access" wants the mode, the role a new account
 * would get and how long the invite lasts in the same breath. Absent or
 * unreadable, the defaults in @polaris/core apply, so an instance that has never
 * opened the screen behaves the same as one that opened it and saved nothing.
 */

import * as core from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";

const SETTING_KEY = "sharing.policy";

export async function sharingPolicy(): Promise<core.SharingPolicy> {
    const stored = await getSetting(SETTING_KEY);
    if (!stored) return core.SHARING_POLICY_DEFAULTS;
    try {
        const parsed = core.sharingPolicySchema.safeParse(JSON.parse(stored));
        // A setting written by an older version can be missing fields a newer one
        // reads; the schema's defaults fill those rather than the whole thing
        // being discarded.
        return parsed.success ? parsed.data : core.SHARING_POLICY_DEFAULTS;
    } catch {
        return core.SHARING_POLICY_DEFAULTS;
    }
}

export async function setSharingPolicy(policy: core.SharingPolicy): Promise<void> {
    await setSetting(SETTING_KEY, JSON.stringify(policy));
}

/**
 * Whether this person may share a thing they hold right now, and why not when
 * they may not - the screen has to be able to say, rather than leave somebody
 * looking for a button that was never drawn.
 *
 * `toStranger` asks the stricter question: giving access to an address with no
 * account means creating one, and Polaris has no public registration, so that is
 * a separate decision from sharing with somebody already here.
 */
export async function canDelegateShare(input: {
    isAdmin: boolean;
    /** Whether they hold the right to pass this thing on: its owner, or a grant
     *  that said so. */
    mayPassOn: boolean;
    toStranger?: boolean;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (input.isAdmin) return { ok: true };
    if (!input.mayPassOn) return { ok: false, reason: "You cannot give other people access to this" };
    const policy = await sharingPolicy();
    if (!core.mayShareAtAll(policy)) {
        return { ok: false, reason: "Only an administrator can give access on this Polaris" };
    }
    if (input.toStranger && !core.mayInviteStrangers(policy)) {
        return { ok: false, reason: "No account matches that. Ask an administrator to invite them." };
    }
    return { ok: true };
}
