/**
 * Reading and writing the grants that reach past a roster.
 *
 * The vocabulary and the arithmetic are `access-grants.ts` in @polaris/core;
 * this is the half that talks to the database. Every app that consults it does
 * so the same way and in the same order: resolve the subject and the caller's
 * ordinary standing first, and only ask here when that came back with nothing.
 * A grant is the last thing tried, never the first, which is what keeps it from
 * quietly becoming the way anybody reaches anything.
 *
 * **Principals are computed from live memberships, never trusted off the row.**
 * A grant to a team is a grant to whoever is on that team this second; one to a
 * role is to whoever holds it. That is the point of granting to a group, and it
 * is also what makes a row that outlived its team harmless - it matches nobody.
 *
 * **Only an act counts as a use.** Looking at a door is not opening it, and a
 * grant limited to four uses that spent one every time a screen drew the lock
 * would be spent before the visitor arrived.
 */

import { prisma, type Prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { createHash, randomBytes } from "node:crypto";
import { teamIdsFor } from "@/lib/orgs/org-service";
import { clientIp } from "@/lib/request-context";
import { hashLinkPassword } from "@polaris/core/link-password";
import {
    linkAddressDenial,
    signUnlock,
    storedAddressRules,
    unlockCookieName,
    verifyUnlock
} from "@/lib/link-guards";

/** Every group one account counts as, for the purpose of matching a grant. */
export interface GrantPrincipals {
    readonly userId: string;
    readonly teamIds: readonly string[];
    readonly roleIds: readonly string[];
}

/** One grant that applies right now, with what it hands over and what is left
 *  of it. */
export interface LiveGrant {
    readonly id: string;
    readonly capability: string;
    /** The actions it allows, resolved (`core.grantActions`): never empty for a
     *  grant that allows something, whatever the row stored. */
    readonly actions: readonly string[];
    /** When it stops applying, or null when nothing bounds it. What a screen
     *  says beside a door somebody has until eleven. */
    readonly until: Date | null;
    /** Whether spending it costs one of a limited number. */
    readonly counted: boolean;
    /** Only near the place: the fence in metres, or null for anywhere. */
    readonly nearbyMeters?: number | null;
}

/** The columns every read here needs. One list so a grant is judged on the same
 *  facts wherever it is asked about. */
const GRANT_FIELDS = {
    id: true,
    subjectType: true,
    subjectId: true,
    capability: true,
    actions: true,
    startsAt: true,
    endsAt: true,
    days: true,
    startMinute: true,
    endMinute: true,
    timeZone: true,
    maxUses: true,
    uses: true,
    nearbyMeters: true
} as const;

type GrantRow = {
    id: string;
    subjectType: string;
    subjectId: string;
    capability: string;
    actions: string[];
    startsAt: Date | null;
    endsAt: Date | null;
    days: number;
    startMinute: number | null;
    endMinute: number | null;
    timeZone: string;
    maxUses: number | null;
    uses: number;
    nearbyMeters: number | null;
};

/**
 * Which groups this account belongs to.
 *
 * A role is matched by its row rather than by its name: a membership stores the
 * slug, and the grant stores the id, so this is where the two meet. Both are
 * read in one query each however many organizations somebody is on.
 */
export async function principalsOf(userId: string): Promise<GrantPrincipals> {
    const [teamIds, memberships] = await Promise.all([
        teamIdsFor(userId),
        prisma.organizationMember.findMany({
            where: { userId },
            select: { orgId: true, role: true }
        })
    ]);

    const roleIds =
        memberships.length === 0
            ? []
            : (
                  await prisma.orgRole.findMany({
                      where: {
                          OR: memberships.map((held) => ({ orgId: held.orgId, slug: held.role }))
                      },
                      select: { id: true }
                  })
              ).map((role) => role.id);

    return { userId, teamIds, roleIds };
}

/** The `where` that matches every grant addressed to one account, however it
 *  was addressed. */
function addressedTo(principals: GrantPrincipals) {
    return {
        OR: [
            { principalType: "user", principalId: principals.userId },
            ...(principals.teamIds.length
                ? [{ principalType: "team", principalId: { in: [...principals.teamIds] } }]
                : []),
            ...(principals.roleIds.length
                ? [{ principalType: "role", principalId: { in: [...principals.roleIds] } }]
                : [])
        ]
    };
}

/**
 * The clock a wall-clock rule is read against when a grant names none.
 *
 * The instance's own: a door's hours are the building's hours, not the
 * visitor's.
 *
 * Asked for only when a row actually needs one, and imported at that moment
 * rather than at the top of the file. Both halves matter. Most grants have no
 * hours at all, so most calls should not read a setting; and this module is
 * reached from the access check of four apps, so pulling the display service -
 * and the session and auth modules behind it - into that graph would make every
 * one of them depend on the environment being configured to answer "may they".
 */
async function houseZone(rows: readonly GrantRow[]): Promise<string> {
    const needed = rows.some(
        (row) => !row.timeZone && (row.startMinute !== null || row.days !== core.EVERY_DAY)
    );
    if (!needed) return "UTC";
    const { getPlatformDisplayPreferences } = await import("@/lib/display-prefs-service");
    return (await getPlatformDisplayPreferences()).timeZone || "UTC";
}

/** What one row allows, in its subject's words. */
function actionsOf(row: { subjectType: string; capability: string; actions: string[] }): string[] {
    return core.isGrantSubject(row.subjectType)
        ? core.grantActions(row.subjectType, row.capability, row.actions)
        : [];
}

/** Whatever of these is in force, judged. */
function live(rows: readonly GrantRow[], zone: string, now: Date): LiveGrant[] {
    const found: LiveGrant[] = [];
    for (const row of rows) {
        const verdict = core.judgeGrant(row, now, zone);
        if (verdict.standing !== "live") continue;
        found.push({
            id: row.id,
            capability: row.capability,
            actions: actionsOf(row),
            until: verdict.until,
            counted: row.maxUses !== null,
            nearbyMeters: row.nearbyMeters
        });
    }
    return found;
}

/**
 * The strongest thing this account has been granted over one subject, or "".
 *
 * The answer every access check wants: a word from that subject's own ladder,
 * which the caller compares with `core.atLeast`.
 */
export async function grantedCapability(
    userId: string,
    subject: core.GrantSubject,
    subjectId: string,
    now = new Date()
): Promise<string> {
    const held = await liveGrants(userId, subject, subjectId, now);
    return core.strongest(
        subject,
        held.map((grant) => grant.capability)
    );
}

/**
 * Every grant in force over one subject for one account, strongest first. What
 * an action that has to spend one reads.
 *
 * The subject is asked about before the caller is, which is the other way round
 * from how it reads. It is deliberate and it is what makes this cheap enough to
 * sit on an access path: almost nothing is shared, so one indexed query answers
 * "nobody has been given this" and the caller's teams and roles - two more
 * queries - are never looked up at all. Where there are rows, only the ones
 * addressed to the caller are read.
 */
export async function liveGrants(
    userId: string,
    subject: core.GrantSubject,
    subjectId: string,
    now = new Date()
): Promise<LiveGrant[]> {
    // One row is enough to know whether anything is shared at all, and the
    // rows that matter are then only the caller's: a thing shared with
    // thousands of people is never read whole on the way into it.
    const any = await prisma.accessGrant.findMany({
        where: { subjectType: subject, subjectId },
        select: { id: true },
        take: 1
    });
    if (any.length === 0) return [];

    const principals = await principalsOf(userId);
    const held = new Set([
        `user:${principals.userId}`,
        ...principals.teamIds.map((id) => `team:${id}`),
        ...principals.roleIds.map((id) => `role:${id}`)
    ]);
    // Matched again in memory: the query narrows, and this is what decides.
    const rows = (
        await prisma.accessGrant.findMany({
            where: { subjectType: subject, subjectId, ...addressedTo(principals) },
            select: { ...GRANT_FIELDS, principalType: true, principalId: true }
        })
    ).filter((row) => held.has(`${row.principalType}:${row.principalId}`));
    if (rows.length === 0) return [];

    const zone = await houseZone(rows);
    return live(rows, zone, now).sort(
        (left, right) =>
            (core.atLeast(subject, right.capability, left.capability) ? 1 : 0) -
            (core.atLeast(subject, left.capability, right.capability) ? 1 : 0)
    );
}

/** One organization membership, as `principalsOfMany` reads it. */
export interface HeldOrgRole {
    readonly userId: string;
    readonly orgId: string;
    readonly role: string;
}

/**
 * `principalsOf` for many accounts at once: one read of the teams and one of
 * the roles however many people are asked about. The memberships are passed in
 * by a caller that already read them for another reason.
 */
export async function principalsOfMany(
    userIds: readonly string[],
    memberships: readonly HeldOrgRole[]
): Promise<GrantPrincipals[]> {
    if (userIds.length === 0) return [];
    const ids = [...new Set(userIds)];
    const pairs = [
        ...new Map(memberships.map((held) => [`${held.orgId}:${held.role}`, held])).values()
    ];
    const [teams, roles] = await Promise.all([
        prisma.teamMember.findMany({
            where: { userId: { in: ids } },
            select: { userId: true, teamId: true }
        }),
        pairs.length === 0
            ? Promise.resolve([])
            : prisma.orgRole.findMany({
                  where: { OR: pairs.map((held) => ({ orgId: held.orgId, slug: held.role })) },
                  select: { id: true, orgId: true, slug: true }
              })
    ]);
    const roleId = new Map(roles.map((role) => [`${role.orgId}:${role.slug}`, role.id]));
    return ids.map((userId) => ({
        userId,
        teamIds: teams.filter((row) => row.userId === userId).map((row) => row.teamId),
        roleIds: memberships
            .filter((held) => held.userId === userId)
            .flatMap((held) => roleId.get(`${held.orgId}:${held.role}`) ?? [])
    }));
}

/**
 * `grantedCapability` for many accounts over one subject: one query for the
 * subject's grants and, only when it has any, one batch of principals. Whoever
 * nothing reaches is left out of the map.
 */
export async function grantedCapabilities(
    userIds: readonly string[],
    subject: core.GrantSubject,
    subjectId: string,
    memberships: () => Promise<readonly HeldOrgRole[]>,
    now = new Date()
): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (userIds.length === 0) return found;
    const all = await prisma.accessGrant.findMany({
        where: { subjectType: subject, subjectId },
        select: { ...GRANT_FIELDS, principalType: true, principalId: true }
    });
    if (all.length === 0) return found;
    const zone = await houseZone(all);
    const inForce = all.filter((row) => core.judgeGrant(row, now, zone).standing === "live");
    if (inForce.length === 0) return found;

    for (const principals of await principalsOfMany(userIds, await memberships())) {
        const held = new Set([
            `user:${principals.userId}`,
            ...principals.teamIds.map((id) => `team:${id}`),
            ...principals.roleIds.map((id) => `role:${id}`)
        ]);
        const best = core.strongest(
            subject,
            inForce
                .filter((row) => held.has(`${row.principalType}:${row.principalId}`))
                .map((row) => row.capability)
        );
        if (best) found.set(principals.userId, best);
    }
    return found;
}

/**
 * Everybody a grant over one subject could reach at `minimum` or above: the
 * people it names, whoever is on the teams and whoever holds the roles. A list
 * of candidates, bounded, for a caller that then judges each one the ordinary
 * way - a grant out of its hours is still in here.
 */
export async function grantHolders(
    subject: core.GrantSubject,
    subjectId: string,
    minimum: string,
    limit = 1_000
): Promise<string[]> {
    const rows = (
        await prisma.accessGrant.findMany({
            where: { subjectType: subject, subjectId },
            select: { principalType: true, principalId: true, capability: true }
        })
    ).filter((row) => core.atLeast(subject, row.capability, minimum));
    if (rows.length === 0) return [];
    const of = (kind: string) =>
        rows.filter((row) => row.principalType === kind).map((row) => row.principalId);
    const [teamMembers, roles] = await Promise.all([
        idsIn(of("team"), (ids) =>
            prisma.teamMember.findMany({
                where: { teamId: { in: ids } },
                take: limit,
                select: { userId: true }
            })
        ),
        idsIn(of("role"), (ids) =>
            prisma.orgRole.findMany({
                where: { id: { in: ids } },
                select: { orgId: true, slug: true }
            })
        )
    ]);
    const roleHolders =
        roles.length === 0
            ? []
            : await prisma.organizationMember.findMany({
                  where: { OR: roles.map((role) => ({ orgId: role.orgId, role: role.slug })) },
                  take: limit,
                  select: { userId: true }
              });
    return [
        ...new Set([
            ...of("user"),
            ...teamMembers.map((row) => row.userId),
            ...roleHolders.map((row) => row.userId)
        ])
    ].slice(0, limit);
}

/**
 * Everything of one kind this account reaches by grant, and what it may do
 * there.
 *
 * One query for the whole app rather than one per thing: a rail listing
 * conversations and a Places screen listing doors both want the set, and asking
 * per row would be a query per row.
 */
export async function grantedSubjects(
    userId: string,
    subject: core.GrantSubject,
    now = new Date()
): Promise<Map<string, string>> {
    const principals = await principalsOf(userId);
    const rows = await prisma.accessGrant.findMany({
        where: { subjectType: subject, ...addressedTo(principals) },
        select: GRANT_FIELDS
    });
    const zone = await houseZone(rows);

    const held = new Map<string, string>();
    for (const row of rows) {
        if (core.judgeGrant(row, now, zone).standing !== "live") continue;
        const best = core.strongest(subject, [held.get(row.subjectId) ?? "", row.capability]);
        held.set(row.subjectId, best);
    }
    return held;
}

/**
 * What this account may do with each thing of one kind it was lent, right now:
 * every action any of its live grants allows, joined. What a screen reads to
 * draw a visitor the buttons they can use and none they cannot.
 */
export async function grantedActions(
    userId: string,
    subject: core.GrantSubject,
    now = new Date()
): Promise<Map<string, string[]>> {
    const principals = await principalsOf(userId);
    const rows = await prisma.accessGrant.findMany({
        where: { subjectType: subject, ...addressedTo(principals) },
        select: GRANT_FIELDS
    });
    const zone = await houseZone(rows);
    const held = new Map<string, string[]>();
    for (const grant of live(rows, zone, now)) {
        const row = rows.find((one) => one.id === grant.id);
        if (!row) continue;
        const joined = new Set([...(held.get(row.subjectId) ?? []), ...grant.actions]);
        held.set(row.subjectId, [...joined]);
    }
    return held;
}

/**
 * Whether this account reaches anything at all of these kinds, right now.
 *
 * The question navigation asks on every page, for everybody who does not hold
 * the app's own permission - which is most people. `grantedSubjects` per kind
 * would resolve the caller's teams and roles once per kind and query once per
 * kind; this resolves them once and asks once, whatever it is asked about.
 *
 * Unlike `liveGrants` there is no cheap "nothing is shared" short circuit to be
 * had: the question is asked by principal, so the query has to be the one that
 * matches the principal. Keeping it to a single query is what makes it bearable
 * on a path that runs on every render.
 */
export async function reachesAnySubject(
    userId: string,
    subjects: readonly core.GrantSubject[],
    now = new Date()
): Promise<boolean> {
    const principals = await principalsOf(userId);
    const rows = await prisma.accessGrant.findMany({
        where: { subjectType: { in: [...subjects] }, ...addressedTo(principals) },
        select: GRANT_FIELDS
    });
    if (rows.length === 0) return false;
    const zone = await houseZone(rows);
    return rows.some((row) => core.judgeGrant(row, now, zone).standing === "live");
}

/**
 * Count one use against a grant, if it is counted at all.
 *
 * Bounded in the statement rather than read and then written, so two presses
 * arriving together cannot both find the last use free. A grant that was spent
 * in between simply does not match, and the caller is told - which is the honest
 * answer, since the thing they asked for has not happened yet.
 */
export async function spendGrant(grant: LiveGrant): Promise<boolean> {
    if (!grant.counted) {
        // `updateMany` rather than `update`: a grant taken back between the check
        // and the act is a row that is no longer there, and stamping when it was
        // last used is not worth turning into an error over something that has
        // already happened.
        await prisma.accessGrant.updateMany({
            where: { id: grant.id },
            data: { lastUsedAt: new Date() }
        });
        return true;
    }
    const row = await prisma.accessGrant.findUnique({
        where: { id: grant.id },
        select: { maxUses: true }
    });
    if (row?.maxUses == null) return false;
    const spent = await prisma.accessGrant.updateMany({
        where: { id: grant.id, uses: { lt: row.maxUses } },
        data: { uses: { increment: 1 }, lastUsedAt: new Date() }
    });
    return spent.count > 0;
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/** One grant as a screen draws it: who it is to, what it hands over, and how it
 *  stands right now. */
export interface GrantView {
    readonly id: string;
    /** Who it was handed to - or `link`, for one handed out as an address. */
    readonly principalType: core.GrantPrincipal | typeof core.LINK_PRINCIPAL;
    readonly principalId: string;
    /** Who or what, named. Empty when the team, role or account behind it has
     *  since been deleted, which is what the listing drops. */
    readonly principalName: string;
    /** The organization it came out of, for a team or a role. */
    readonly orgName: string;
    readonly capability: string;
    /** What it allows, resolved: see `LiveGrant.actions`. */
    readonly actions: readonly string[];
    readonly standing: core.GrantStanding;
    readonly until: string | null;
    readonly schedule: {
        readonly startsAt: string | null;
        readonly endsAt: string | null;
        readonly days: number;
        readonly startMinute: number | null;
        readonly endMinute: number | null;
        readonly timeZone: string;
        readonly maxUses: number | null;
        readonly uses: number;
        readonly nearbyMeters: number | null;
    };
    readonly note: string;
    readonly createdAt: string;
    /** A link only: who it opens for. "anyone" for every other row. */
    readonly audience: core.LinkAudience;
    /** A link only: whether it asks for a password. Never the password. */
    readonly password: boolean;
    /** What a row prints under the name: an address when that person lets the
     *  viewer see it, else their handle; empty for a group. */
    readonly contact: string;
}

/**
 * Every grant one thing hands out.
 *
 * A grant whose principal no longer exists is dropped rather than drawn as a
 * blank row: nothing has reached anybody through it since the day the team was
 * deleted, and a screen listing it invites somebody to worry about access that
 * is not there.
 */
export async function listSubjectGrants(
    subject: core.GrantSubject,
    subjectId: string,
    now = new Date(),
    principalTypes?: readonly string[]
): Promise<GrantView[]> {
    const rows = await prisma.accessGrant.findMany({
        where: {
            subjectType: subject,
            subjectId,
            ...(principalTypes ? { principalType: { in: [...principalTypes] } } : {})
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: principalTypes ? core.MAX_GRANTS_PER_SUBJECT : core.GRANT_PAGE_SIZE
    });
    return viewsOf(rows, now, null);
}

/** One page of a subject's grants, as the dialog asks for it. */
export interface GrantPageQuery {
    /** People, teams and roles - or the links. Never both on one page. */
    readonly links: boolean;
    /** Narrowed to principals whose name or handle has this in it. */
    readonly search?: string;
    /** The last row of the previous page. */
    readonly cursor?: string | null;
    readonly limit?: number;
}

export interface GrantPage {
    readonly grants: GrantView[];
    /** How many rows match, whatever the page size. */
    readonly total: number;
    readonly nextCursor: string | null;
}

/**
 * A page of what one thing hands out, oldest first, with the total.
 *
 * Bounded whatever the subject carries: a page is at most GRANT_PAGE_SIZE rows,
 * read off the (subject, createdAt, id) index, and the count is one indexed
 * count. A search first finds, among the people, teams and roles this subject
 * is handed to, the ones whose names match, and then pages the rows for those.
 */
export async function listSubjectGrantPage(
    subject: core.GrantSubject,
    subjectId: string,
    query: GrantPageQuery,
    viewer: { id: string; isAdmin: boolean } | null,
    now = new Date()
): Promise<GrantPage> {
    const limit = Math.min(Math.max(query.limit ?? core.GRANT_PAGE_SIZE, 1), core.GRANT_PAGE_SIZE);
    const kinds = query.links ? [core.LINK_PRINCIPAL] : ["user", "team", "role"];
    const where: { [key: string]: unknown } = {
        subjectType: subject,
        subjectId,
        principalType: { in: kinds }
    };
    const term = (query.search ?? "").trim();
    if (term.length > 0 && !query.links) {
        const ids = await principalsNamed(subject, subjectId, term);
        if (ids.length === 0) return { grants: [], total: 0, nextCursor: null };
        where.principalId = { in: ids };
    }
    const [rows, total] = await Promise.all([
        prisma.accessGrant.findMany({
            where,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: limit + 1,
            ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
        }),
        prisma.accessGrant.count({ where })
    ]);
    const page = rows.slice(0, limit);
    return {
        grants: await viewsOf(page, now, viewer),
        total,
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null
    };
}

/** The ids of the people, teams and roles one subject is handed to whose
 *  names have this in them. Bounded by what a subject may carry. */
async function principalsNamed(
    subject: core.GrantSubject,
    subjectId: string,
    term: string
): Promise<string[]> {
    const held = await prisma.accessGrant.findMany({
        where: { subjectType: subject, subjectId, principalType: { in: ["user", "team", "role"] } },
        select: { principalType: true, principalId: true },
        take: core.MAX_GRANTS_PER_SUBJECT
    });
    const of = (type: string) => [
        ...new Set(held.filter((one) => one.principalType === type).map((one) => one.principalId))
    ];
    const [userIds, teamIds, roleIds] = [of("user"), of("team"), of("role")];
    const contains = { contains: term, mode: "insensitive" as const };
    const [users, teams, roles] = await Promise.all([
        userIds.length > 0
            ? prisma.user.findMany({
                  where: { id: { in: userIds }, OR: [{ name: contains }, { username: contains }] },
                  select: { id: true }
              })
            : [],
        teamIds.length > 0
            ? prisma.team.findMany({
                  where: { id: { in: teamIds }, name: contains },
                  select: { id: true }
              })
            : [],
        roleIds.length > 0
            ? prisma.orgRole.findMany({
                  where: { id: { in: roleIds }, name: contains },
                  select: { id: true }
              })
            : []
    ]);
    return [...users, ...teams, ...roles].map((one) => one.id);
}

type StoredGrant = Awaited<ReturnType<typeof prisma.accessGrant.findMany>>[number];

async function viewsOf(
    rows: readonly StoredGrant[],
    now: Date,
    viewer: { id: string; isAdmin: boolean } | null
): Promise<GrantView[]> {
    if (rows.length === 0) return [];
    const zone = await houseZone(rows);

    const named = await nameParticipants(rows);
    const contacts = viewer ? await contactsOf(viewer, rows) : new Map<string, string>();
    const views: GrantView[] = [];
    for (const row of rows) {
        // A link names nobody: what the screen says for it is its note.
        const found =
            row.principalType === core.LINK_PRINCIPAL
                ? { name: "", orgName: "" }
                : named.get(`${row.principalType}:${row.principalId}`);
        const who = found
            ? {
                  ...found,
                  contact: row.principalType === "user" ? contacts.get(row.principalId) : ""
              }
            : undefined;
        if (!who) continue;
        const verdict = core.judgeGrant(row, now, zone);
        views.push({
            id: row.id,
            principalType: row.principalType as GrantView["principalType"],
            principalId: row.principalId,
            principalName: who.name,
            orgName: who.orgName,
            capability: row.capability,
            actions: actionsOf(row),
            standing: verdict.standing,
            until: verdict.until?.toISOString() ?? null,
            schedule: {
                startsAt: row.startsAt?.toISOString() ?? null,
                endsAt: row.endsAt?.toISOString() ?? null,
                days: row.days,
                startMinute: row.startMinute,
                endMinute: row.endMinute,
                timeZone: row.timeZone,
                maxUses: row.maxUses,
                uses: row.uses,
                nearbyMeters: row.nearbyMeters
            },
            note: row.note,
            createdAt: row.createdAt.toISOString(),
            audience: core.linkAudienceOf(row.linkAudience),
            password: Boolean(row.linkPasswordHash),
            contact: who.contact ?? ""
        });
    }
    return views;
}

/** The names behind a page of grants, in three queries whatever the mix. */
async function nameParticipants(
    rows: readonly { principalType: string; principalId: string }[]
): Promise<Map<string, { name: string; orgName: string }>> {
    const of = (kind: string) =>
        rows.filter((row) => row.principalType === kind).map((row) => row.principalId);
    const [users, teams, roles] = await Promise.all([
        idsIn(of("user"), (ids) =>
            prisma.user.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true, username: true }
            })
        ),
        idsIn(of("team"), (ids) =>
            prisma.team.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true, org: { select: { name: true } } }
            })
        ),
        idsIn(of("role"), (ids) =>
            prisma.orgRole.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true, org: { select: { name: true } } }
            })
        )
    ]);

    const named = new Map<string, { name: string; orgName: string }>();
    for (const user of users) {
        named.set(`user:${user.id}`, { name: user.name || user.username || "", orgName: "" });
    }
    for (const team of teams) {
        named.set(`team:${team.id}`, { name: team.name, orgName: team.org.name });
    }
    for (const role of roles) {
        named.set(`role:${role.id}`, { name: role.name, orgName: role.org.name });
    }
    return named;
}

async function idsIn<T>(ids: string[], read: (ids: string[]) => Promise<T[]>): Promise<T[]> {
    return ids.length === 0 ? [] : read([...new Set(ids)]);
}

/**
 * What may be printed under each person on a page, for this viewer: the one
 * rule every roster follows (`contactLines`), imported when a page is drawn
 * rather than at the top - this module sits on the access path of four apps.
 */
async function contactsOf(
    viewer: { id: string; isAdmin: boolean },
    rows: readonly { principalType: string; principalId: string }[]
): Promise<Map<string, string>> {
    const ids = [
        ...new Set(rows.filter((row) => row.principalType === "user").map((row) => row.principalId))
    ];
    if (ids.length === 0) return new Map();
    const people = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, email: true, username: true }
    });
    const { contactLines } = await import("@/lib/privacy-service");
    return contactLines(viewer, people);
}

/** Refused because of what was asked for rather than who asked. The caller shows
 *  the sentence. */
export class GrantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GrantError";
    }
}

/**
 * Write one.
 *
 * Nothing here decides whether the caller may share this thing - that is the
 * subject's own rule, checked by whoever called. What is checked is that the
 * grant makes sense: a capability the subject has, a principal that exists, and
 * a ceiling on how many one thing may carry.
 *
 * `orgIds` is which organizations' teams and roles are on the table, resolved by
 * the caller from what owns the subject. It is a parameter rather than something
 * worked out here because only the dispatcher knows what owns a subject - but it
 * is required, so the rule that a conversation belonging to one organization
 * cannot be handed to another's people is enforced at the write and not only in
 * the picker that fills the form.
 */
export async function writeGrant(
    subject: core.GrantSubject,
    subjectId: string,
    input: core.AccessGrantInput,
    grantedById: string,
    orgIds: readonly string[]
): Promise<string> {
    const data = await grantData(subject, subjectId, input, grantedById, orgIds);
    const held = await prisma.accessGrant.count({ where: { subjectType: subject, subjectId } });
    if (held >= core.MAX_GRANTS_PER_SUBJECT) {
        throw new GrantError("This already has as many shares as it can hold");
    }
    const written = await prisma.accessGrant.create({ data, select: { id: true } });
    return written.id;
}

/**
 * Write several at once, all or none: every one is checked as `writeGrant`
 * checks it before any is written, so a refusal halfway leaves nothing behind
 * to be written a second time when the same list is sent again.
 */
export async function writeGrants(
    subject: core.GrantSubject,
    subjectId: string,
    inputs: readonly core.AccessGrantInput[],
    grantedById: string,
    orgIds: readonly string[]
): Promise<number> {
    const data = [];
    for (const input of inputs) {
        data.push(await grantData(subject, subjectId, input, grantedById, orgIds));
    }
    if (data.length === 0) return 0;
    const held = await prisma.accessGrant.count({ where: { subjectType: subject, subjectId } });
    if (held + data.length > core.MAX_GRANTS_PER_SUBJECT) {
        throw new GrantError("This already has as many shares as it can hold");
    }
    const written = await prisma.accessGrant.createMany({ data });
    return written.count;
}

/** One grant's row, once it has been checked to make sense for the subject. */
async function grantData(
    subject: core.GrantSubject,
    subjectId: string,
    input: core.AccessGrantInput,
    grantedById: string,
    orgIds: readonly string[]
) {
    const allowed = core.GRANT_CAPABILITIES[subject] as readonly string[];
    if (!allowed.includes(input.capability)) {
        throw new GrantError("That is not something this can be shared as");
    }
    // Only actions this subject has, and only ones the capability reaches: a
    // list that names nothing usable would read back as "everything".
    const actions = [...new Set(input.actions)];
    const reachable = core.grantActions(subject, input.capability, []);
    if (actions.some((action) => !reachable.includes(action))) {
        throw new GrantError("That is not something this can be shared as");
    }
    if (!core.subjectPrincipals(subject).includes(input.principalType)) {
        throw new GrantError("That is not something this can be shared as");
    }
    if (!(await principalExists(input.principalType, input.principalId, orgIds))) {
        throw new GrantError(
            input.principalType === "user"
                ? "That person no longer exists"
                : "That team or role is not one this can be shared with"
        );
    }
    return {
        subjectType: subject,
        subjectId,
        principalType: input.principalType,
        principalId: input.principalId,
        capability: input.capability,
        actions,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        days: input.days,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        timeZone: input.timeZone,
        maxUses: input.maxUses,
        nearbyMeters: input.nearbyMeters,
        note: input.note,
        grantedById
    };
}

// ---------------------------------------------------------------------------
// Links: a grant held by whoever has the address
// ---------------------------------------------------------------------------

/**
 * The id a link's grant is filed under: the first half of the token's SHA-256,
 * shaped as the uuid the column holds. The token itself is never stored, so a
 * copy of the database opens no door; 128 bits of a hash of 256 random bits is
 * more than any guess will find.
 */
export function linkPrincipalId(token: string): string {
    const hex = createHash("sha256").update(token).digest("hex").slice(0, 32);
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20)
    ].join("-");
}

/** What a link's address carries: 32 random bytes, URL-safe. */
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Hand one subject out as a link, for somebody with no account. The token comes
 * back once, to be copied; only its hash is kept. Same bounds as any grant, and
 * counted against the same ceiling.
 */
export async function writeGrantLink(
    subject: core.GrantLinkSubject,
    subjectId: string,
    input: core.GrantLinkInput,
    grantedById: string,
    /** The organization an `org` link opens for: the one that owns the thing. */
    orgId: string | null = null
): Promise<{ id: string; token: string }> {
    const audience = core.linkAudienceOf(input.audience);
    if (audience === "org" && !orgId) {
        throw new GrantError("This does not belong to an organization");
    }
    // Narrower than a person's: a NAS, a server or a domain is only ever seen
    // through a link, whatever a person could be given.
    const allowed = core.linkCapabilities(subject);
    if (!allowed.includes(input.capability)) {
        throw new GrantError("That is not something this can be shared as");
    }
    const actions = [...new Set(input.actions)];
    const reachable = core.grantActions(subject, input.capability, []);
    if (actions.some((action) => !reachable.includes(action))) {
        throw new GrantError("That is not something this can be shared as");
    }
    const held = await prisma.accessGrant.count({ where: { subjectType: subject, subjectId } });
    if (held >= core.MAX_GRANTS_PER_SUBJECT) {
        throw new GrantError("This already has as many shares as it can hold");
    }
    const token = randomBytes(32).toString("base64url");
    const written = await prisma.accessGrant.create({
        data: {
            subjectType: subject,
            subjectId,
            principalType: core.LINK_PRINCIPAL,
            principalId: linkPrincipalId(token),
            capability: input.capability,
            actions,
            startsAt: input.startsAt ? new Date(input.startsAt) : null,
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            days: input.days,
            startMinute: input.startMinute,
            endMinute: input.endMinute,
            timeZone: input.timeZone,
            maxUses: input.maxUses,
            nearbyMeters: input.nearbyMeters,
            note: input.note,
            ...storedAddressRules(input),
            linkAudience: audience,
            linkOrgId: audience === "org" ? orgId : null,
            linkPasswordHash: input.password ? await hashLinkPassword(input.password) : null,
            grantedById
        },
        select: { id: true }
    });
    return { id: written.id, token };
}

/** What one link's address leads to, judged now. */
export type LinkReach =
    | {
          readonly standing: "live";
          readonly subjectType: string;
          readonly subjectId: string;
          readonly grant: LiveGrant;
          readonly note: string;
      }
    | {
          readonly standing: Exclude<core.GrantStanding, "live">;
          readonly subjectType: string;
          readonly subjectId: string;
          readonly note: string;
      };

/**
 * The grant behind a link's token, or null when there is none - never written,
 * or taken back. A malformed token is refused before the database is asked.
 */
export async function linkReach(token: string, now = new Date()): Promise<LinkReach | null> {
    return judgeLink(token, now, false);
}

/**
 * The same, for a use that has already been paid for: a camera's live view is
 * counted once when it is opened, and the stream it then pulls for minutes
 * must not be cut because that open was the last use. Dates, hours and
 * revocation still apply to every request; only the count is set aside.
 */
export async function linkReachPaid(token: string, now = new Date()): Promise<LinkReach | null> {
    return judgeLink(token, now, true);
}

async function judgeLink(token: string, now: Date, paid: boolean): Promise<LinkReach | null> {
    if (!LINK_TOKEN.test(token)) return null;
    const found = await prisma.accessGrant.findFirst({
        where: { principalType: core.LINK_PRINCIPAL, principalId: linkPrincipalId(token) },
        select: {
            ...GRANT_FIELDS,
            note: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            linkAudience: true,
            linkOrgId: true,
            linkPasswordHash: true
        }
    });
    if (!found) return null;
    const row = paid ? { ...found, maxUses: null } : found;
    const zone = await houseZone([row]);
    const verdict = core.judgeGrant(row, now, zone);
    const base = { subjectType: row.subjectType, subjectId: row.subjectId, note: row.note };
    if (verdict.standing !== "live") return { standing: verdict.standing, ...base };
    // The same address rules every public link answers to, after liveness so a
    // link that is off says so to everyone. Outside a request there is no
    // caller to place, which a rule refuses and no rule ignores.
    const ip = await clientIp().catch(() => undefined);
    if (await linkAddressDenial(row, ip)) return { standing: "elsewhere", ...base };
    const audience = core.linkAudienceOf(row.linkAudience);
    if (audience !== "anyone") {
        const refused = await audienceRefusal(audience, row, now);
        if (refused) return { standing: refused, ...base };
    }
    // Last, so a link that is off, or not for this account, says that rather
    // than asking for a password that would not help.
    if (row.linkPasswordHash && !(await grantLinkUnlocked(row.id, row.linkPasswordHash))) {
        return { standing: "password", ...base };
    }
    const [grant] = live([row], zone, now);
    return grant ? { standing: "live", grant, ...base } : { standing: "spent", ...base };
}
/** The unlock-cookie namespace grant links are signed under. */
const GRANT_LINK_SCOPE = "grant_link";

/** The cookie that records a solved password for one grant link. */
export function grantLinkUnlockCookie(grantId: string): string {
    return unlockCookieName(GRANT_LINK_SCOPE, grantId);
}

/** Sign the "password solved" marker for one grant link. Bound to the stored
 *  hash, so a new password ends every unlock handed out before it. */
export function signGrantLinkUnlock(grantId: string, passwordHash: string, secret: string): string {
    return signUnlock(GRANT_LINK_SCOPE, grantId, { passwordHash }, secret);
}

/**
 * Whether this request carries a valid unlock for this link. Read here, in the
 * one check every press goes through, so the password guards the presses and
 * the camera's stream as well as the page. Outside a request there is no
 * cookie to read, which is refused.
 */
async function grantLinkUnlocked(grantId: string, passwordHash: string): Promise<boolean> {
    try {
        const [{ cookies }, { loadEnv }] = await Promise.all([
            import("next/headers"),
            import("@polaris/config")
        ]);
        const value = (await cookies()).get(grantLinkUnlockCookie(grantId))?.value;
        return verifyUnlock(
            GRANT_LINK_SCOPE,
            grantId,
            value,
            { passwordHash },
            loadEnv().POLARIS_AUTH_SECRET
        );
    } catch {
        return false;
    }
}

/**
 * The link behind a token as its password gate needs it: the row and its hash,
 * or null when there is no such link or it asks for no password.
 */
export async function grantLinkPassword(
    token: string
): Promise<{ id: string; passwordHash: string } | null> {
    if (!LINK_TOKEN.test(token)) return null;
    const row = await prisma.accessGrant.findFirst({
        where: { principalType: core.LINK_PRINCIPAL, principalId: linkPrincipalId(token) },
        select: { id: true, linkPasswordHash: true }
    });
    return row?.linkPasswordHash ? { id: row.id, passwordHash: row.linkPasswordHash } : null;
}

/**
 * Whether the person signed in is somebody an account-only link opens for.
 *
 * `restricted` is somebody who already has the thing - by a grant of their own,
 * or because they may share it, which is what its owners and administrators
 * can. `org` is anybody signed in to the organization the link was written for.
 * The session and the sharing rules are imported here, on demand: almost every
 * link is an `anyone` link, and this module is on four apps' access path.
 */
async function audienceRefusal(
    audience: Exclude<core.LinkAudience, "anyone">,
    row: { subjectType: string; subjectId: string; linkOrgId: string | null },
    now: Date
): Promise<"signin" | "denied" | null> {
    const { guardedUser } = await import("@/lib/session");
    const viewer = await guardedUser({ touch: false }).catch(() => null);
    if (!viewer) return "signin";
    if (audience === "org") {
        if (!row.linkOrgId) return "denied";
        const member = await prisma.organizationMember.findFirst({
            where: { orgId: row.linkOrgId, userId: viewer.id },
            select: { userId: true }
        });
        return member ? null : "denied";
    }
    if (!core.isGrantSubject(row.subjectType)) return "denied";
    const held = await liveGrants(viewer.id, row.subjectType, row.subjectId, now);
    if (held.length > 0) return null;
    const { requireMayShare } = await import("@/lib/access/sharing-service");
    try {
        await requireMayShare(viewer, row.subjectType, row.subjectId);
        return null;
    } catch {
        return "denied";
    }
}

/**
 * Whether the chosen principal is one this subject may actually be handed to.
 *
 * A person is anybody on the instance: people are found by searching, and that
 * search obeys the privacy rules on its own. A team and a role are not - they
 * belong to an organization, and only the ones that own the subject are on
 * offer. An empty list means nothing is, which is what a subject owned by no
 * organization comes to for a sharer who is on none.
 */
async function principalExists(
    kind: core.GrantPrincipal,
    id: string,
    orgIds: readonly string[]
): Promise<boolean> {
    if (kind === "user") {
        return Boolean(await prisma.user.findUnique({ where: { id }, select: { id: true } }));
    }
    if (orgIds.length === 0) return false;
    const where = { id, orgId: { in: [...orgIds] } };
    if (kind === "team") {
        return Boolean(await prisma.team.findFirst({ where, select: { id: true } }));
    }
    return Boolean(await prisma.orgRole.findFirst({ where, select: { id: true } }));
}

/**
 * Take one back.
 *
 * Scoped to the subject as well as the id, so a route that has already resolved
 * what the caller may share cannot be handed the id of a grant on something
 * else.
 */
export async function removeGrant(
    subject: core.GrantSubject,
    subjectId: string,
    grantId: string
): Promise<void> {
    await prisma.accessGrant.deleteMany({
        where: { id: grantId, subjectType: subject, subjectId }
    });
}

/**
 * Change what one grant hands over - its capability, its actions and its
 * bounds - without changing who it is to. Scoped to the subject like
 * `removeGrant`, and held to the same rules as a fresh write: a link may still
 * only carry what a link may.
 */
export async function updateGrant(
    subject: core.GrantSubject,
    subjectId: string,
    grantId: string,
    input: core.GrantUpdateInput
): Promise<void> {
    const row = await prisma.accessGrant.findFirst({
        where: { id: grantId, subjectType: subject, subjectId },
        select: { principalType: true }
    });
    if (!row) throw new GrantError("That share is no longer there");
    const allowed =
        row.principalType === core.LINK_PRINCIPAL && core.isGrantLinkSubject(subject)
            ? core.linkCapabilities(subject)
            : (core.GRANT_CAPABILITIES[subject] as readonly string[]);
    if (!allowed.includes(input.capability)) {
        throw new GrantError("That is not something this can be shared as");
    }
    const actions = [...new Set(input.actions)];
    const reachable = core.grantActions(subject, input.capability, []);
    if (actions.some((action) => !reachable.includes(action))) {
        throw new GrantError("That is not something this can be shared as");
    }
    await prisma.accessGrant.updateMany({
        where: { id: grantId, subjectType: subject, subjectId },
        data: {
            capability: input.capability,
            actions,
            startsAt: input.startsAt ? new Date(input.startsAt) : null,
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            days: input.days,
            startMinute: input.startMinute,
            endMinute: input.endMinute,
            timeZone: input.timeZone,
            maxUses: input.maxUses,
            nearbyMeters: input.nearbyMeters,
            note: input.note
        }
    });
}

/** Who one link opens for, changed in place: the address stays the same, so a
 *  link already sent starts or stops working for whoever holds it. */
export async function setLinkAudience(
    subject: core.GrantSubject,
    subjectId: string,
    grantId: string,
    audience: core.LinkAudience,
    orgId: string | null
): Promise<void> {
    if (audience === "org" && !orgId) {
        throw new GrantError("This does not belong to an organization");
    }
    const changed = await prisma.accessGrant.updateMany({
        where: { id: grantId, subjectType: subject, subjectId, principalType: core.LINK_PRINCIPAL },
        data: { linkAudience: audience, linkOrgId: audience === "org" ? orgId : null }
    });
    if (changed.count === 0) throw new GrantError("That share is no longer there");
}

/**
 * Lending grants for domains that no longer exist, dropped. A domain goes with
 * its app, environment and project too, by cascade, so the grants are matched
 * against what is left rather than against one id.
 */
export async function dropGrantsOfGoneDomains(): Promise<void> {
    const lent = await prisma.accessGrant.findMany({
        where: { subjectType: "place.domain" },
        select: { subjectId: true },
        distinct: ["subjectId"]
    });
    if (lent.length === 0) return;
    const ids = lent.map((grant) => grant.subjectId);
    const present = await prisma.domain.findMany({
        where: { id: { in: ids } },
        select: { id: true }
    });
    const kept = new Set(present.map((domain) => domain.id));
    const gone = ids.filter((id) => !kept.has(id));
    if (gone.length > 0)
        await prisma.accessGrant.deleteMany({
            where: { subjectType: "place.domain", subjectId: { in: gone } }
        });
}

/** Everything one subject hands out, gone - what deleting the subject itself
 *  has to do, since nothing here is a foreign key. */
export async function dropGrantsFor(
    subject: core.GrantSubject,
    subjectId: string | readonly string[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    const ids = typeof subjectId === "string" ? [subjectId] : [...subjectId];
    if (ids.length === 0) return;
    await client.accessGrant.deleteMany({
        where: { subjectType: subject, subjectId: { in: ids } }
    });
}

// ---------------------------------------------------------------------------
// The access log
// ---------------------------------------------------------------------------

/** How long a use is kept: the same 90 days camera events default to. */
export const GRANT_USE_RETENTION_DAYS = 90;

/** At most one prune per process this often; the writer does it, so there is
 *  no job to forget to schedule. */
const PRUNE_EVERY_MS = 60 * 60_000;
let prunedAt = 0;

/** One use of a grant, to be recorded. */
export interface GrantUseInput {
    readonly grantId: string | null;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly targetType: string;
    readonly targetId: string;
    /** The person, or null for a link. */
    readonly userId: string | null;
    readonly linkNote?: string;
    readonly action: string;
    readonly outcome: "done" | "refused";
    readonly reason?: string;
}

/**
 * Write one row of the access log. Never throws: it records something that
 * already happened (or was already refused), and failing to write it must not
 * turn into a different answer for the person at the door.
 */
export async function recordGrantUse(use: GrantUseInput, now = new Date()): Promise<void> {
    await recordGrantUses([use], now);
}

/** `recordGrantUse` for many at once, in one write - one action over a
 *  hundred messages is a hundred rows, not a hundred round trips. */
export async function recordGrantUses(
    uses: readonly GrantUseInput[],
    now = new Date()
): Promise<void> {
    if (uses.length === 0) return;
    try {
        await prisma.grantUse.createMany({
            data: uses.map((use) => ({
                grantId: use.grantId,
                subjectType: use.subjectType,
                subjectId: use.subjectId,
                targetType: use.targetType,
                targetId: use.targetId,
                userId: use.userId,
                linkNote: (use.linkNote ?? "").slice(0, 200),
                action: use.action.slice(0, 40),
                outcome: use.outcome,
                reason: (use.reason ?? "").slice(0, 80),
                at: now
            }))
        });
        if (now.getTime() - prunedAt >= PRUNE_EVERY_MS) {
            prunedAt = now.getTime();
            await pruneGrantUses(now);
        }
    } catch (caught) {
        console.error("polaris: a grant use could not be logged:", caught);
    }
}

/** Drop what is older than the retention. */
export async function pruneGrantUses(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - GRANT_USE_RETENTION_DAYS * 86_400_000);
    const { count } = await prisma.grantUse.deleteMany({ where: { at: { lt: before } } });
    return count;
}

export const GRANT_USE_OUTCOMES = ["done", "refused"] as const;

/** What the log can be narrowed to. */
export interface GrantUseQuery {
    readonly subjectType: string;
    readonly subjectId: string;
    readonly grantId?: string | undefined;
    readonly outcome?: (typeof GRANT_USE_OUTCOMES)[number] | undefined;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
    readonly take: number;
}

/** One row as a manager reads it. */
export interface GrantUseView {
    readonly id: string;
    readonly at: string;
    readonly grantId: string | null;
    /** A person's name, or empty for a link (then `linkNote` says which). */
    readonly who: string;
    readonly link: boolean;
    readonly linkNote: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly action: string;
    readonly outcome: string;
    readonly reason: string;
}

/**
 * The uses of one subject's grants, newest first: the grants over it, and the
 * grants over a room that reached it. Callers check the reader may share it.
 */
export async function listGrantUses(query: GrantUseQuery): Promise<GrantUseView[]> {
    const rows = await prisma.grantUse.findMany({
        where: {
            OR: [
                { subjectType: query.subjectType, subjectId: query.subjectId },
                { targetId: query.subjectId }
            ],
            ...(query.grantId ? { grantId: query.grantId } : {}),
            ...(query.outcome ? { outcome: query.outcome } : {}),
            ...(query.from || query.to
                ? {
                      at: {
                          ...(query.from ? { gte: query.from } : {}),
                          ...(query.to ? { lte: query.to } : {})
                      }
                  }
                : {})
        },
        orderBy: { at: "desc" },
        take: query.take
    });
    const ids = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
    const people = ids.length
        ? await prisma.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true }
          })
        : [];
    const names = new Map(people.map((person) => [person.id, person.name]));
    return rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        grantId: row.grantId,
        who: row.userId ? (names.get(row.userId) ?? "") : "",
        link: row.userId === null,
        linkNote: row.linkNote,
        targetType: row.targetType,
        targetId: row.targetId,
        action: row.action,
        outcome: row.outcome,
        reason: row.reason
    }));
}
