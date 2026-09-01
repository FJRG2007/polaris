/**
 * A person's own page, at an address that can be handed out.
 *
 * Polaris draws faces and panels all over itself, but there was nowhere to send
 * somebody: no "this is me" that survives being pasted into a message, a
 * signature or a CV. This is that page, and everything about it follows from
 * what it is - a page whose whole purpose is to be seen by somebody who is not
 * already looking at the same screen as you.
 *
 * **The address carries a prefix.** `/u/<username>`, not `/<username>`. A person
 * can be called anything, and a product whose profiles sit at the root has to
 * keep taking names away from people every time it adds a page. The prefix is
 * what makes `RESERVED_USERNAMES` a rule about impersonation rather than a list
 * of routes.
 *
 * **Nothing new is published.** Every field here is one the account already
 * publishes somewhere in the product, and each is filtered through the same
 * privacy settings the rest of Polaris asks - so making a profile reachable adds
 * an address, never a disclosure.
 *
 * **Signed out is a stranger.** Somebody with no account is on nobody's friends
 * list and in nobody's exceptions, so they see only what is set to "everybody",
 * full stop - not the "everybody except" that would have to name them to
 * exclude them. And they see nothing at all unless the operator has said
 * profiles may be read without signing in, which is off by default: an instance
 * is not always a company, and publishing its roster to the internet is not a
 * decision a per-account setting should be able to make on the operator's
 * behalf.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { blockedBetween } from "@/lib/blocks";
import { getSetting, setSetting } from "@/lib/setting-store";
import { allowedBy, type PrivacyViewer } from "@/lib/privacy-service";

/** Whether a profile may be read by somebody with no session. */
const PUBLIC_KEY = "profiles.public";

/**
 * Whether this Polaris shows profiles to people who are not signed in.
 *
 * Off unless an operator has said otherwise. The safe answer is the default for
 * the reason every closed default here is: the person who would be exposed by
 * getting it wrong is not the person setting it.
 */
export async function profilesArePublic(): Promise<boolean> {
    return (await getSetting(PUBLIC_KEY)) === "true";
}

export async function setProfilesPublic(allowed: boolean): Promise<void> {
    await setSetting(PUBLIC_KEY, allowed ? "true" : null);
}

/** One organization somebody says they belong to. */
export interface ProfileCompany {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
}

/** A person, as their own page draws them. */
export interface PublicProfile {
    readonly id: string;
    readonly name: string;
    readonly username: string;
    /** Their name, both halves, when they have given either and allow this
     *  reader to see it. Empty otherwise. */
    readonly fullName: string;
    readonly description: string;
    /** Whether their photo may be drawn for this reader. Initials otherwise. */
    readonly showsAvatar: boolean;
    /**
     * The organizations on this Polaris they have marked as theirs. Verified in
     * the only sense Polaris can verify anything: these are rosters it holds, and
     * the person is on them.
     */
    readonly organizations: ProfileCompany[];
    /** The line they typed, which Polaris knows nothing about. Empty when they
     *  typed none, or when this reader may not see where they work. */
    readonly company: string;
    /** Their address, for the readers they show it to. */
    readonly email: string;
    readonly joinedAt: string;
}

/** The org ids an account has marked, out of its own column. Anything
 *  unparseable reads as none rather than failing a page. */
function markedOrgIds(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
        return [];
    }
}

/** Store the marks, keeping only ids the account is actually on a roster for -
 *  the list arrives from a browser like any other. */
export async function setProfileOrganizations(userId: string, ids: readonly string[]): Promise<void> {
    const mine = await organizationsOf(userId);
    const kept = mine.filter((org) => ids.includes(org.id)).map((org) => org.id);
    await prisma.user.update({
        where: { id: userId },
        data: { profileOrgIds: kept.length > 0 ? JSON.stringify(kept) : null }
    });
}

/**
 * Every organization on this Polaris an account belongs to, owned or joined.
 *
 * Used both by the profile and by the screen that chooses what it shows, so the
 * list somebody picks from and the list that is published cannot drift.
 */
export async function organizationsOf(userId: string): Promise<ProfileCompany[]> {
    const orgs = await prisma.organization.findMany({
        where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
        orderBy: { name: "asc" },
        select: { id: true, name: true, slug: true }
    });
    return orgs;
}

/** Which of them this account has chosen to show, in the same order. */
export async function shownOrganizations(userId: string): Promise<ProfileCompany[]> {
    const [user, orgs] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { profileOrgIds: true } }),
        organizationsOf(userId)
    ]);
    const marked = new Set(markedOrgIds(user?.profileOrgIds ?? null));
    return orgs.filter((org) => marked.has(org.id));
}

/**
 * A profile by username, as this reader may see it, or null.
 *
 * Null covers every reason at once - no such account, an account that has taken
 * itself out of being found, a block in either direction, and a reader with no
 * session on an instance that does not publish profiles. One answer, because
 * telling them apart tells somebody which of them it was, which is exactly what
 * "nobody can find me" exists to prevent.
 */
export async function publicProfile(
    username: string,
    viewer: PrivacyViewer | null
): Promise<PublicProfile | null> {
    const handle = username.trim().toLowerCase();
    if (!handle) return null;

    if (!viewer && !(await profilesArePublic())) return null;

    const user = await prisma.user.findUnique({
        where: { username: handle },
        select: {
            id: true,
            name: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
            company: true,
            description: true,
            profileOrgIds: true,
            bannedAt: true,
            createdAt: true
        }
    });
    // A suspended account has no profile. Said as "no such person" rather than
    // as its state, which is nobody else's business.
    if (!user || !user.username || user.bannedAt) return null;

    // Their own page always answers, whatever their settings say - it is what
    // shows somebody what everybody else is being shown.
    const own = viewer?.id === user.id;
    if (!own) {
        if (viewer && (await blockedBetween(viewer.id, [user.id])).has(user.id)) return null;
        const allowed = await visible(user.id, viewer, [
            "discoverable",
            "avatar",
            "fullName",
            "email",
            "companies"
        ]);
        if (!allowed.discoverable) return null;
        return draw(user, allowed);
    }
    return draw(user, {
        discoverable: true,
        avatar: true,
        fullName: true,
        email: true,
        companies: true
    });
}

type Fields = Record<"discoverable" | "avatar" | "fullName" | "email" | "companies", boolean>;

/**
 * What this reader may see of each field.
 *
 * A reader with no session is a stranger: on nobody's friends list and in
 * nobody's exceptions, so only "everybody" reaches them. Asked of the stored
 * settings directly rather than through `allowedBy`, which needs an id to answer
 * about.
 */
async function visible(
    userId: string,
    viewer: PrivacyViewer | null,
    fields: readonly (keyof Fields)[]
): Promise<Fields> {
    if (viewer) {
        const answers = await Promise.all(
            fields.map(async (field) => [field, (await allowedBy(viewer, field, [userId])).has(userId)] as const)
        );
        return Object.fromEntries(answers) as Fields;
    }
    const row = await prisma.userPrivacy.findUnique({
        where: { userId },
        select: { discoverable: true, avatar: true, fullName: true, email: true, companies: true }
    });
    // `storedAudience` is the one way to read one off a row: a column holds a
    // string written years ago, a row may not exist at all, and neither may be
    // allowed to resolve to something more open than the field's own default.
    const open = (field: keyof Fields) =>
        core.storedAudience(field, row?.[field]) === "everyone";
    return {
        discoverable: open("discoverable"),
        avatar: open("avatar"),
        fullName: open("fullName"),
        email: open("email"),
        companies: open("companies")
    };
}

/** Nothing here depends on who asked beyond what `allowed` already decided,
 *  which is the point: one place turns settings into a yes, and this only
 *  assembles what the yes permits. */
async function draw(
    user: {
        id: string;
        name: string;
        username: string | null;
        firstName: string | null;
        lastName: string | null;
        email: string;
        company: string | null;
        description: string;
        profileOrgIds: string | null;
        createdAt: Date;
    },
    allowed: Fields
): Promise<PublicProfile> {
    const marked = markedOrgIds(user.profileOrgIds);
    const organizations =
        allowed.companies && marked.length > 0
            ? await prisma.organization.findMany({
                  where: {
                      id: { in: marked },
                      // Re-checked at read time, so an organization somebody left
                      // stops appearing on their profile without them having to
                      // remember to un-mark it.
                      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }]
                  },
                  orderBy: { name: "asc" },
                  select: { id: true, name: true, slug: true }
              })
            : [];

    const full = [user.firstName ?? "", user.lastName ?? ""].join(" ").trim();
    return {
        id: user.id,
        name: user.name,
        username: user.username ?? "",
        fullName: allowed.fullName ? full : "",
        description: user.description,
        showsAvatar: allowed.avatar,
        organizations,
        company: allowed.companies ? (user.company ?? "") : "",
        email: allowed.email ? user.email : "",
        joinedAt: user.createdAt.toISOString()
    };
}
