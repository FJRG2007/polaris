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
import { areFriends } from "@/lib/friends-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { followCounts, followsPerson } from "@/lib/people-follow";
import { allowedBy, defaultFollowerAudience, type PrivacyViewer } from "@/lib/privacy-service";

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


/** What one reader may do about the person whose page they are on. */
export interface ProfileStanding {
    /** Null on your own page, where none of it applies. */
    readonly friendship: "none" | "friends" | "sent" | "received" | null;
    readonly following: boolean;
    /** Whether a conversation is offered. Friends only: a message from a
     *  stranger is what a block list exists because of, and following somebody
     *  is not a relationship they agreed to. */
    readonly canMessage: boolean;
}

/** A person, as their own page draws them. */
export interface PublicProfile {
    readonly id: string;
    readonly name: string;
    readonly username: string;
    /** The one line under the name. Empty when they have written none. */
    readonly headline: string;
    /** How they want to be referred to, in their own words. Empty when they have
     *  not said, and then nothing is drawn - an empty value is a person who did
     *  not answer, not a field waiting to be filled in. */
    readonly pronouns: string;
    /** The addresses they hand out with themselves. */
    readonly links: core.ProfileLink[];
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
    /**
     * The places they typed, which Polaris knows nothing about beyond that
     * somebody typed them. Several, because a person holds several at a time -
     * and empty when they typed none, or when this reader may not see where they
     * work.
     */
    readonly companies: string[];
    /** Their address, for the readers they show it to. */
    readonly email: string;
    readonly joinedAt: string;
    /** How many follow them and how many they follow, or null where this reader
     *  may not see either. The numbers and the lists are one disclosure, so one
     *  setting decides both. */
    readonly follows: { readonly followers: number; readonly following: number } | null;
    /** What this reader may do about them. */
    readonly standing: ProfileStanding;
}

/** A stored JSON list of strings, out of its own column. Anything unparseable
 *  reads as none rather than failing a page. */
function storedList(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

/**
 * The places somebody typed.
 *
 * `profileCompanies` is the list; `company` is the single column that existed
 * before there could be more than one, and is still what the administration
 * screens read. An account that has never opened the new screen has only the
 * second, so it stands in - which is what keeps a name typed a year ago on the
 * page it was typed for.
 */
export function typedCompanies(row: { profileCompanies: string | null; company: string | null }): string[] {
    const list = storedList(row.profileCompanies);
    if (list.length > 0) return list;
    const single = (row.company ?? "").trim();
    return single ? [single] : [];
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
 * Store the places somebody typed.
 *
 * `company` is written with the first of them, deliberately: the administration
 * screens and the user directory read that one column, and leaving it holding
 * last year's answer while the profile showed this year's is exactly the drift a
 * second source of truth causes. One writer, so they cannot disagree.
 */
export async function setProfileCompanies(userId: string, names: readonly string[]): Promise<void> {
    const kept: string[] = [];
    for (const name of names) {
        const trimmed = name.trim();
        // The same name twice is one place, and an empty row is somebody who
        // added a field and did not fill it in.
        if (trimmed && !kept.includes(trimmed)) kept.push(trimmed);
        if (kept.length >= core.MOST_COMPANIES) break;
    }
    await prisma.user.update({
        where: { id: userId },
        data: {
            profileCompanies: kept.length > 0 ? JSON.stringify(kept) : null,
            company: kept[0] ?? null
        }
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
    const marked = new Set(storedList(user?.profileOrgIds ?? null));
    return orgs.filter((org) => marked.has(org.id));
}

/**
 * An organization's own page.
 *
 * The same idea as a person's and at the same kind of address - `/o/<slug>`,
 * beside `/u/<username>` - because a handle here addresses a page whoever it
 * belongs to. The two share one namespace and always have: an organization
 * cannot take a handle somebody signs in with, which is what makes the two
 * prefixes a convenience rather than the thing keeping them apart.
 *
 * The people on it are exactly those who marked it on their own profile, and
 * that is the whole membership rule. A roster is the organization's private
 * business - being on one is not a statement anybody made about themselves - so
 * publishing it would be publishing a list of employees none of them agreed to.
 * What is published is the set of people who said "I work here", one at a time,
 * on their own screen.
 */
export interface OrgProfile {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    /** The people who show this organization on their own profile. */
    readonly people: { id: string; name: string; username: string }[];
    readonly createdAt: string;
    /** Whether the reader may open the organization's own screens - they are on
     *  its roster, or they run this Polaris. */
    readonly manageable: boolean;
}

export async function orgProfile(slug: string, viewer: PrivacyViewer | null): Promise<OrgProfile | null> {
    const handle = slug.trim().toLowerCase();
    if (!handle) return null;
    if (!viewer && !(await profilesArePublic())) return null;

    const org = await prisma.organization.findUnique({
        where: { slug: handle },
        select: { id: true, slug: true, name: true, description: true, createdAt: true, ownerId: true }
    });
    if (!org) return null;

    // Everybody who has marked it, resolved in one query rather than by walking
    // the roster: the roster is not what is being published, and reading it here
    // would be reading the thing this page deliberately does not show.
    const marked = await prisma.user.findMany({
        where: {
            bannedAt: null,
            username: { not: null },
            // A JSON array in a text column, so the id is matched as a substring
            // and then confirmed exactly below - `contains` is the widest thing
            // both Postgres and SQLite agree on.
            profileOrgIds: { contains: org.id }
        },
        select: { id: true, name: true, username: true, profileOrgIds: true }
    });

    const people = marked
        .filter((person) => storedList(person.profileOrgIds).includes(org.id))
        .map((person) => ({ id: person.id, name: person.name, username: person.username ?? "" }))
        .sort((left, right) => left.name.localeCompare(right.name));

    const manageable = viewer
        ? viewer.isAdmin ||
          org.ownerId === viewer.id ||
          (await prisma.organizationMember.findUnique({
              where: { orgId_userId: { orgId: org.id, userId: viewer.id } },
              select: { id: true }
          })) !== null
        : false;

    return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        description: org.description,
        people,
        createdAt: org.createdAt.toISOString(),
        manageable
    };
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
            profileCompanies: true,
            description: true,
            headline: true,
            pronouns: true,
            links: true,
            profileOrgIds: true,
            bannedAt: true,
            createdAt: true
        }
    });
    // A suspended account has no profile. Said as "no such person" rather than
    // as its state, which is nobody else's business.
    if (!user || !user.username || user.bannedAt) return null;

    const own = viewer?.id === user.id;
    if (!own && viewer && (await blockedBetween(viewer.id, [user.id])).has(user.id)) return null;

    const allowed = await visible(user.id, viewer, [
        "discoverable",
        "avatar",
        "fullName",
        "email",
        "companies",
        "followers"
    ]);

    // Somebody can always open their own page - a setting that hid it from its
    // own owner would be a setting nobody could find. Everything else on it
    // stays exactly as they have set it, and that is the point: this page is
    // what other people see, so showing its owner an address they have told
    // Polaris to keep private would be showing them a page that does not exist.
    if (!own && !allowed.discoverable) return null;
    return draw(user, allowed, viewer, own);
}

type Fields = Record<
    "discoverable" | "avatar" | "fullName" | "email" | "companies" | "followers",
    boolean
>;

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
        select: {
            discoverable: true,
            avatar: true,
            fullName: true,
            email: true,
            companies: true,
            followers: true
        }
    });
    // `storedAudience` is the one way to read one off a row: a column holds a
    // string written years ago, a row may not exist at all, and neither may be
    // allowed to resolve to something more open than the field's own default.
    const open = (field: keyof Fields) =>
        core.storedAudience(field, row?.[field]) === "everyone";
    // The follower lists are the one field whose unset answer is the operator's
    // rather than the schema's, so it is filled in before it is read.
    const followers = row?.followers ?? (await defaultFollowerAudience());
    return {
        discoverable: open("discoverable"),
        avatar: open("avatar"),
        fullName: open("fullName"),
        email: open("email"),
        companies: open("companies"),
        followers: core.storedAudience("followers", followers) === "everyone"
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
        profileCompanies: string | null;
        description: string;
        headline: string | null;
        pronouns: string | null;
        links: string | null;
        profileOrgIds: string | null;
        createdAt: Date;
    },
    allowed: Fields,
    viewer: PrivacyViewer | null,
    own: boolean
): Promise<PublicProfile> {
    const marked = storedList(user.profileOrgIds);
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
    const [follows, standing] = await Promise.all([
        allowed.followers ? followCounts(user.id) : Promise.resolve(null),
        standingOf(user.id, viewer, own)
    ]);
    return {
        id: user.id,
        name: user.name,
        username: user.username ?? "",
        fullName: allowed.fullName ? full : "",
        description: user.description,
        showsAvatar: allowed.avatar,
        organizations,
        companies: allowed.companies ? typedCompanies(user) : [],
        email: allowed.email ? user.email : "",
        joinedAt: user.createdAt.toISOString(),
        headline: user.headline ?? "",
        pronouns: user.pronouns ?? "",
        links: profileLinks(user.links),
        follows,
        standing
    };
}

/** The links on a profile, out of their column. Re-validated on the way out
 *  rather than trusted: they were checked when they were stored, and a page that
 *  prints an address is the wrong place to find out that changed. */
export function profileLinks(raw: string | null): core.ProfileLink[] {
    if (!raw) return [];
    try {
        const parsed = core.profileLinksSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

/**
 * What this reader may do about the person whose page it is.
 *
 * A message is offered to friends and to nobody else. Following somebody is not
 * a relationship they agreed to - that is the whole difference between the two -
 * and a conversation opened by a stranger is what a block list exists because
 * of.
 */
async function standingOf(
    personId: string,
    viewer: PrivacyViewer | null,
    own: boolean
): Promise<ProfileStanding> {
    if (own || !viewer) return { friendship: null, following: false, canMessage: false };

    const [friends, following, pending] = await Promise.all([
        areFriends(viewer.id, personId),
        followsPerson(viewer.id, personId),
        prisma.friendship.findFirst({
            where: {
                status: "pending",
                OR: [
                    { requesterId: viewer.id, addresseeId: personId },
                    { requesterId: personId, addresseeId: viewer.id }
                ]
            },
            select: { requesterId: true }
        })
    ]);

    const friendship = friends
        ? ("friends" as const)
        : pending
          ? pending.requesterId === viewer.id
              ? ("sent" as const)
              : ("received" as const)
          : ("none" as const);
    return { friendship, following, canMessage: friends };
}

/** Store the one line under somebody's name, how they want to be referred to,
 *  and the addresses they hand out. Validated here as well as in the form,
 *  because a form is a courtesy. */
export async function saveProfileDetails(
    userId: string,
    input: { headline: string; pronouns: string; links: readonly core.ProfileLink[] }
): Promise<void> {
    const links = core.profileLinksSchema.parse(input.links);
    await prisma.user.update({
        where: { id: userId },
        data: {
            headline: core.headlineField.parse(input.headline) || null,
            pronouns: core.pronounsField.parse(input.pronouns) || null,
            links: links.length > 0 ? JSON.stringify(links) : null
        }
    });
}
