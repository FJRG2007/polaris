/**
 * A link's limits as the columns they are stored in, written the one way every
 * link that takes `linkLimitsSchema` stores them: the password hashed, and only
 * touched when one is typed or it is being taken off; the address rules as the
 * JSON lists `lib/link-guards` reads.
 */

import type * as core from "@polaris/core";
import { storedAddressRules } from "@/lib/link-guards";
import { hashLinkPassword } from "@polaris/core/link-password";

export async function linkLimitColumns(limits: core.LinkLimitsInput) {
    return {
        ...(limits.password
            ? { passwordHash: await hashLinkPassword(limits.password) }
            : limits.clearPassword
              ? { passwordHash: null }
              : {}),
        expiresAt: limits.expiresAt,
        maxViews: limits.maxViews,
        ...storedAddressRules(limits)
    };
}
