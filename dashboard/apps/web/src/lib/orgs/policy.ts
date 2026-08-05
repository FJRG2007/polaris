/**
 * What this instance allows organizations to be.
 *
 * One stored setting rather than four, because the four are read together every
 * time: a screen deciding whether to offer "New organization" wants the creation
 * mode and the per-account cap in the same breath. Absent or unreadable, the
 * defaults in @polaris/core apply, so an instance that has never opened the
 * screen behaves the same as one that opened it and saved nothing.
 */

import * as core from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";

const SETTING_KEY = "organizations.policy";

export async function organizationPolicy(): Promise<core.OrganizationPolicy> {
    const stored = await getSetting(SETTING_KEY);
    if (!stored) return core.ORGANIZATION_POLICY_DEFAULTS;
    try {
        const parsed = core.organizationPolicySchema.safeParse(JSON.parse(stored));
        // A setting written by an older version can be missing fields a newer one
        // reads; the schema's defaults fill those rather than the whole thing
        // being discarded.
        return parsed.success ? parsed.data : core.ORGANIZATION_POLICY_DEFAULTS;
    } catch {
        return core.ORGANIZATION_POLICY_DEFAULTS;
    }
}

export async function setOrganizationPolicy(policy: core.OrganizationPolicy): Promise<void> {
    await setSetting(SETTING_KEY, JSON.stringify(policy));
}

/** Whether this account may start an organization right now. Answers the reason
 *  as well, because the screen has to say why the button is not there. */
export async function canCreateOrganization(
    isAdmin: boolean,
    ownedCount: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const policy = await organizationPolicy();
    if (policy.creation === "off") return { ok: false, reason: "Organizations are turned off on this Polaris" };
    if (policy.creation === "admins" && !isAdmin) {
        return { ok: false, reason: "Only an administrator can create an organization here" };
    }
    if (!core.withinLimit(policy.maxPerUser, ownedCount)) {
        return {
            ok: false,
            reason: `You already own the most organizations this Polaris allows (${policy.maxPerUser})`
        };
    }
    return { ok: true };
}
