/**
 * What the privacy screen shows, read on the server: three settings, in one
 * query. The page starts it without awaiting and streams the answer with its
 * shell; `data.ts` is what a retry or a refresh asks instead.
 */

import * as core from "@polaris/core";
import { getSettings } from "@/lib/setting-store";
import { PUBLIC_KEY } from "@/lib/profile-service";
import { LINK_PREVIEWS_KEY } from "@/lib/chat/link-preview-policy";
import { chatE2eeEnabled } from "@/lib/chat/e2ee/flag";
import { INACTIVE_DEVICE_DAYS_SETTING, inactiveDaysFrom } from "@/lib/chat/e2ee/mls-delivery";
import { isLockValue, privacyDefaultKey, privacyLockKey } from "@/lib/privacy-service";
import { DISCOVERY_POLICY_KEY, readDiscoveryPolicy, type DiscoveryPolicy } from "@/lib/discovery-policy";

export interface PrivacyData {
    publicProfiles: boolean;
    /** What each field resolves to for an account that never chose it. */
    defaults: Record<core.PrivacyField, core.PrivacyAudience>;
    /** The fields held to their default for every account. */
    locks: core.PrivacyField[];
    discovery: DiscoveryPolicy;
    /** Whether Chat may draw link previews at all. */
    linkPreviews: boolean;
    /** Days a sealed-chat device may go unused before it leaves its conversations; null while sealed chat is off. */
    sealedDeviceDays: number | null;
}

export async function readPrivacy(): Promise<PrivacyData> {
    const stored = await getSettings([
        PUBLIC_KEY,
        DISCOVERY_POLICY_KEY,
        LINK_PREVIEWS_KEY,
        INACTIVE_DEVICE_DAYS_SETTING,
        ...core.PRIVACY_FIELDS.map(privacyDefaultKey),
        ...core.PRIVACY_FIELDS.map(privacyLockKey)
    ]);
    return {
        publicProfiles: stored.get(PUBLIC_KEY) === "true",
        linkPreviews: stored.get(LINK_PREVIEWS_KEY) !== "off",
        sealedDeviceDays: chatE2eeEnabled() ? inactiveDaysFrom(stored.get(INACTIVE_DEVICE_DAYS_SETTING)) : null,
        defaults: Object.fromEntries(
            core.PRIVACY_FIELDS.map((field) => [
                field,
                core.resolvedAudience(field, null, stored.get(privacyDefaultKey(field)) ?? null)
            ])
        ) as Record<core.PrivacyField, core.PrivacyAudience>,
        locks: core.PRIVACY_FIELDS.filter((field) =>
            isLockValue(stored.get(privacyLockKey(field)))
        ),
        discovery: readDiscoveryPolicy(stored.get(DISCOVERY_POLICY_KEY) ?? null)
    };
}
