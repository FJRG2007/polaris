/**
 * What the privacy screen shows, read on the server: three settings, in one
 * query. The page starts it without awaiting and streams the answer with its
 * shell; `data.ts` is what a retry or a refresh asks instead.
 */

import * as core from "@polaris/core";
import { getSettings } from "@/lib/setting-store";
import { PUBLIC_KEY } from "@/lib/profile-service";
import { privacyDefaultKey } from "@/lib/privacy-service";
import { DISCOVERY_POLICY_KEY, readDiscoveryPolicy, type DiscoveryPolicy } from "@/lib/discovery-policy";

export interface PrivacyData {
    publicProfiles: boolean;
    /** What each field resolves to for an account that never chose it. */
    defaults: Record<core.PrivacyField, core.PrivacyAudience>;
    discovery: DiscoveryPolicy;
}

export async function readPrivacy(): Promise<PrivacyData> {
    const stored = await getSettings([
        PUBLIC_KEY,
        DISCOVERY_POLICY_KEY,
        ...core.PRIVACY_FIELDS.map(privacyDefaultKey)
    ]);
    return {
        publicProfiles: stored.get(PUBLIC_KEY) === "true",
        defaults: Object.fromEntries(
            core.PRIVACY_FIELDS.map((field) => [
                field,
                core.resolvedAudience(field, null, stored.get(privacyDefaultKey(field)) ?? null)
            ])
        ) as Record<core.PrivacyField, core.PrivacyAudience>,
        discovery: readDiscoveryPolicy(stored.get(DISCOVERY_POLICY_KEY) ?? null)
    };
}
