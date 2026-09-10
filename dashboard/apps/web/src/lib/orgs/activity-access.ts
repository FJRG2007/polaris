/**
 * Who may read one organization's history, answered once for the page route and
 * the export route alike.
 */

import { hasOrgPermission } from "@polaris/core";
import { orgIdForSlug, resolveOrgAccess } from "./org-service";

/** The organization's id when this account may read its history, and null for an
 *  organization it has no part in or whose history it may not read - the two are
 *  deliberately one answer. */
export async function orgActivityReader(
    user: { id: string; isAdmin: boolean },
    slug: string
): Promise<string | null> {
    const orgId = await orgIdForSlug(slug.toLowerCase());
    if (!orgId) return null;
    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, orgId);
    return access && hasOrgPermission(access.permissions, "activity.read") ? orgId : null;
}
