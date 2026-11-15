/**
 * What the privacy screen shows, read on the server: three settings, in one
 * query. The page starts it without awaiting and streams the answer with its
 * shell; `data.ts` is what a retry or a refresh asks instead.
 */

import * as core from "@polaris/core";
import { getSettings } from "@/lib/setting-store";
import { PUBLIC_KEY } from "@/lib/profile-service";
import { FOLLOWERS_DEFAULT_KEY } from "@/lib/privacy-service";
import { DISCOVERY_POLICY_KEY, readDiscoveryPolicy, type DiscoveryPolicy } from "@/lib/discovery-policy";

export interface PrivacyData {
    publicProfiles: boolean;
    followerDefault: core.PrivacyAudience;
    discovery: DiscoveryPolicy;
}

export async function readPrivacy(): Promise<PrivacyData> {
    const stored = await getSettings([PUBLIC_KEY, FOLLOWERS_DEFAULT_KEY, DISCOVERY_POLICY_KEY]);
    return {
        publicProfiles: stored.get(PUBLIC_KEY) === "true",
        followerDefault: core.storedAudience("followers", stored.get(FOLLOWERS_DEFAULT_KEY) ?? null),
        discovery: readDiscoveryPolicy(stored.get(DISCOVERY_POLICY_KEY) ?? null)
    };
}
