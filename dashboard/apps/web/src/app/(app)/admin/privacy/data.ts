"use server";

/**
 * What the privacy screen shows, asked for by the browser after the page has
 * painted (see `PrivacyLoader`).
 */

import { requireAdmin } from "@/lib/session";
import { discoveryPolicy } from "@/lib/people-search";
import { profilesArePublic } from "@/lib/profile-service";
import { defaultFollowerAudience } from "@/lib/privacy-service";

export async function loadPrivacyAction() {
    await requireAdmin();
    const [publicProfiles, followerDefault, discovery] = await Promise.all([
        profilesArePublic(),
        defaultFollowerAudience(),
        discoveryPolicy()
    ]);
    return { publicProfiles, followerDefault, discovery };
}
