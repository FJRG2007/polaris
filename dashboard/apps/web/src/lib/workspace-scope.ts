/**
 * Which shelf the person looking at Polaris is working from.
 *
 * One account is two working lives: their own servers, lists and domains, and
 * the work of a company they belong to. Those are not the same shelf, and mixing
 * them is how somebody deploys a client's service onto their personal project by
 * accident. So the header carries a switch, and every screen that lists owned
 * things reads it.
 *
 * Held in a cookie because it has to survive a reload and a new tab, and because
 * it must be readable by a server component before anything paints - a scope
 * fetched after the fact is a screenful of the wrong shelf.
 *
 * Nothing here is authorization. A scope narrows what is listed; what somebody
 * may do inside it is still the organization's roles, resolved where the write
 * happens. That is why an unknown or no-longer-valid scope silently falls back to
 * the personal one rather than erroring: the cookie is whatever the browser
 * presents, and "your own things" is the only answer that is always true for
 * whoever is asking.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { cookies } from "next/headers";
import { PERSONAL_SHELF, shelfKey } from "@/lib/shelf";

/** The cookie the switch writes. Not http-only: the switcher reads it to draw
 *  itself, and it carries no secret - the id it names is checked server-side on
 *  every read anyway. */
export const SCOPE_COOKIE = "polaris.scope";

/** A year. The shelf somebody works from is a standing preference, not a
 *  session's detail; a freelancer who works for one client wants it to still be
 *  chosen next month. */
export const SCOPE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export interface ResolvedScope {
    readonly scope: core.WorkspaceScope;
    /** Null on the personal shelf. Present and confirmed otherwise: the account
     *  was still on this organization's roster when this was resolved. */
    readonly org: { readonly id: string; readonly slug: string; readonly name: string } | null;
}

/** Everything the switcher offers: the personal shelf, and each organization
 *  this account belongs to in any capacity. */
export interface ScopeChoice {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}

/**
 * The scope this request is in.
 *
 * The membership is re-checked here, on every request, rather than trusted from
 * the cookie. Somebody removed from an organization keeps the cookie naming it
 * until their browser is told otherwise, and a stale cookie must not be a way
 * back into a roster they left - so the check happens where the answer is used.
 *
 * Memoized per request, so a layout, a page and the components under it resolve
 * it once between them.
 */
export const resolveScope = cache(async (userId: string): Promise<ResolvedScope> => {
    const scope = core.parseScope(await chosenScope());
    const orgId = core.scopeOrgId(scope);
    if (!orgId) return { scope: core.personalScope, org: null };

    const org = await prisma.organization.findFirst({
        where: { id: orgId, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
        select: { id: true, slug: true, name: true }
    });
    // Left the organization, or it is gone. Their own shelf, without an error:
    // there is nothing here for them to fix.
    if (!org) return { scope: core.personalScope, org: null };
    return { scope: core.orgScope(org.id), org };
});

/**
 * What the browser asked for, or nothing.
 *
 * Not everything that reaches a scoped read is a request. A scheduled pass, a
 * sweep, a live-channel handler - none of them have cookies, and `cookies()`
 * throws rather than answering when there is no request around it. The personal
 * shelf is the right answer for all of them, and it is the same answer this
 * already gives an unreadable cookie: a scope narrows a listing, so the widest
 * thing anybody owns is never wrong to fall back to.
 */
async function chosenScope(): Promise<string | undefined> {
    try {
        return (await cookies()).get(SCOPE_COOKIE)?.value;
    } catch {
        return undefined;
    }
}

/** The organizations this account can work from, named, for the switcher. */
export async function scopeChoices(userId: string): Promise<ScopeChoice[]> {
    const orgs = await prisma.organization.findMany({
        where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
        orderBy: { name: "asc" },
        select: { id: true, slug: true, name: true }
    });
    return orgs;
}

/** The organization a query should filter on, or null for the personal shelf.
 *  What most callers actually want, since `orgId` is the column they filter. */
export async function scopeOrgIdFor(userId: string): Promise<string | null> {
    return (await resolveScope(userId)).org?.id ?? null;
}

/** The open shelf as the string a notification row stores and the client's
 *  `useShelfScope` returns: `personal`, or an organization's id. */
export async function openShelfFor(userId: string): Promise<string> {
    return shelfKey(await scopeOrgIdFor(userId));
}

/**
 * The shelf to file an alert about work under, for the person receiving it.
 *
 * `undefined` is an alert about the account itself, filed under no shelf and so
 * shown on every one. Otherwise the work's own shelf - with one exception: an
 * organization this person cannot switch to. Somebody given a single space of a
 * company they are not on the roster of has no shelf to open it from, and an
 * alert filed there would be one they could never see; it is theirs, so it goes
 * where every shelf shows it.
 */
export async function recipientShelf(
    userId: string,
    about: { readonly orgId: string | null } | undefined
): Promise<string | null> {
    if (!about) return null;
    if (!about.orgId) return PERSONAL_SHELF;
    const member = await prisma.organization.findFirst({
        where: { id: about.orgId, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
        select: { id: true }
    });
    return member ? about.orgId : null;
}
