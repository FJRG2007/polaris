/**
 * What a "who visited" list may say about where a visit came from.
 *
 * One rule for every visitor log - shared links, drop points, snippets - so no
 * screen can drift from it. A visitor who was signed in to Polaris is shown as
 * their profile and nothing else: their address and their browser are theirs,
 * and a link is not a way to collect them. A visitor nobody can name is shown
 * with what the visit carried, because for an anonymous visit that is the only
 * way to tell one caller from another, which is what the log is for.
 */

export interface VisitOrigin {
    readonly ip: string | null;
    readonly userAgent: string | null;
}

/** The address and browser a visitor log may show for one visit. */
export function visitOrigin(visit: {
    readonly userId?: string | null;
    readonly ip?: string | null;
    readonly userAgent?: string | null;
}): VisitOrigin {
    if (visit.userId) return { ip: null, userAgent: null };
    return { ip: visit.ip ?? null, userAgent: visit.userAgent ?? null };
}
