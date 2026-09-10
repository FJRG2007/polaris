/**
 * Who may read one organization's history, or its statement, answered once for
 * the page route and the export route alike.
 */

import { orgIdForSlug, resolveOrgAccess } from "./org-service";
import { hasOrgPermission, type OrgPermission } from "@polaris/core";

/** The organization's id when this account holds `permission` in it, and null
 *  for an organization it has no part in or where it does not - the two are
 *  deliberately one answer. */
export async function orgReaderWith(
    user: { id: string; isAdmin: boolean },
    slug: string,
    permission: OrgPermission
): Promise<string | null> {
    const orgId = await orgIdForSlug(slug.toLowerCase());
    if (!orgId) return null;
    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, orgId);
    return access && hasOrgPermission(access.permissions, permission) ? orgId : null;
}

/** The organization's id when this account may read its history. */
export async function orgActivityReader(
    user: { id: string; isAdmin: boolean },
    slug: string
): Promise<string | null> {
    return orgReaderWith(user, slug, "activity.read");
}
