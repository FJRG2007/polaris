/**
 * Whose Polaris you are looking at.
 *
 * One person uses the same instance for two different things: their own servers,
 * their own lists, their own domains - and the work of a company they belong to.
 * Those are not the same shelf, and mixing them is how somebody deploys a client's
 * service onto their personal project by accident. So every screen that shows
 * owned things reads a scope, and the scope is either "me" or one organization.
 *
 * Deliberately not a permission. A scope narrows what is *listed*; what somebody
 * may *do* inside it is still decided by the organization's own roles. Picking an
 * organization you are only a member of shows you that organization's work at a
 * member's reach, which is exactly right - the switcher is a filter, never a
 * promotion.
 *
 * Stored as a string because it travels in a cookie and in URLs. Pure, so the
 * browser and the server read it the same way.
 */

/** The personal shelf, written out. Never a real organization id: an id is a UUID
 *  and this is not, so the two can share one field without ambiguity. */
export const PERSONAL_SCOPE = "personal";

export type WorkspaceScope = { readonly kind: "personal" } | { readonly kind: "org"; readonly orgId: string };

/** The personal scope as a value, so callers do not each build the object. */
export const personalScope: WorkspaceScope = { kind: "personal" };

export function orgScope(orgId: string): WorkspaceScope {
    return { kind: "org", orgId };
}

/** The stored form: `personal`, or `org:<id>`. */
export function formatScope(scope: WorkspaceScope): string {
    return scope.kind === "personal" ? PERSONAL_SCOPE : `org:${scope.orgId}`;
}

/**
 * Read a stored scope back.
 *
 * Anything unrecognised is the personal shelf rather than an error. This value
 * arrives from a cookie, which is to say from whoever holds the browser: a
 * malformed one must land somewhere safe and empty-handed, and "your own things"
 * is the only scope that is always true for whoever is asking.
 */
export function parseScope(raw: string | null | undefined): WorkspaceScope {
    if (!raw || raw === PERSONAL_SCOPE) return personalScope;
    const orgId = raw.startsWith("org:") ? raw.slice(4).trim() : "";
    return orgId ? orgScope(orgId) : personalScope;
}

/** The organization a scope names, or null for the personal one. What most
 *  queries actually want, since `orgId` is the column they filter on. */
export function scopeOrgId(scope: WorkspaceScope): string | null {
    return scope.kind === "org" ? scope.orgId : null;
}

export function sameScope(left: WorkspaceScope, right: WorkspaceScope): boolean {
    return formatScope(left) === formatScope(right);
}
