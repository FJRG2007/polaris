/**
 * The gate every one of an organization's screens goes through.
 *
 * One helper rather than the same six lines at the top of eight pages, because
 * the interesting rule is easy to get subtly wrong and has to be identical
 * everywhere: a handle that exists but is not this account's is answered exactly
 * as one that does not exist. Anything else turns the URL into a way of finding
 * out which organizations a Polaris has and who is in them.
 *
 * A screen the reader may not open is `notFound` too, not a refusal page. They
 * were never shown the link - the rail hides what they cannot reach - so arriving
 * here means the URL was typed or kept, and the honest answer to "is there a
 * roles screen for Acme" is still none of their business.
 *
 * Memoized per request, so a page and the components under it resolve the same
 * organization once between them.
 */

import { cache } from "react";
import * as core from "@polaris/core";
import { notFound } from "next/navigation";
import { requireUser, type SessionUser } from "@/lib/session";
import { getOrg, orgIdForSlug, resolveOrgAccess, type OrgDetail, type OrgMembership } from "./org-service";

export interface OrgPageContext {
    readonly user: SessionUser;
    readonly org: OrgDetail;
    readonly access: OrgMembership;
}

const resolve = cache(async (slug: string): Promise<OrgPageContext | null> => {
    const user = await requireUser();
    const orgId = await orgIdForSlug(slug.toLowerCase());
    if (!orgId) return null;

    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, orgId);
    if (!access) return null;

    const org = await getOrg(orgId);
    return org ? { user, org, access } : null;
});

/**
 * The organization this screen is about, or a 404. Pass the permission the
 * screen needs; leave it out for the ones anybody on the roster may open.
 *
 * "Anybody on the roster" is `org.read` rather than "has an answer at all",
 * because not everybody with an answer is on the roster: the successor an owner
 * named resolves to a membership holding nothing, precisely so that leaving the
 * permission off here still keeps them out. Every real role carries `org.read`
 * whether its editor granted it or not, so this changes nothing for a member.
 */
export async function requireOrgPage(slug: string, permission?: core.OrgPermission): Promise<OrgPageContext> {
    const context = await resolve(slug);
    if (!context) notFound();
    if (!core.hasOrgPermission(context.access.permissions, permission ?? "org.read")) notFound();
    return context;
}

/**
 * The organization for the frame around those screens, and for the one screen
 * that decides its own answer.
 *
 * No permission check at all: the layout is chrome, and the settings screen is
 * opened by two different people for two different halves of it, so it works out
 * for itself which half applies rather than being let in on one permission. Not
 * a way around the gate - a layout hands nothing to the pages under it, and each
 * page still calls `requireOrgPage` for itself.
 */
export async function requireOrgFrame(slug: string): Promise<OrgPageContext> {
    const context = await resolve(slug);
    if (!context) notFound();
    return context;
}
