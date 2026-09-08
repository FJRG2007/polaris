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

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { teamIdsFor } from "@/lib/orgs/org-service";

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
    /** When it stops applying, or null when nothing bounds it. What a screen
     *  says beside a door somebody has until eleven. */
    readonly until: Date | null;
    /** Whether spending it costs one of a limited number. */
    readonly counted: boolean;
}

/** The columns every read here needs. One list so a grant is judged on the same
 *  facts wherever it is asked about. */
const GRANT_FIELDS = {
    id: true,
    subjectId: true,
    capability: true,
    startsAt: true,
    endsAt: true,
    days: true,
    startMinute: true,
    endMinute: true,
    timeZone: true,
    maxUses: true,
    uses: true
} as const;

type GrantRow = {
    id: string;
    subjectId: string;
    capability: string;
    startsAt: Date | null;
    endsAt: Date | null;
    days: number;
    startMinute: number | null;
    endMinute: number | null;
    timeZone: string;
    maxUses: number | null;
    uses: number;
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

/** Whatever of these is in force, judged. */
function live(rows: readonly GrantRow[], zone: string, now: Date): LiveGrant[] {
    const found: LiveGrant[] = [];
    for (const row of rows) {
        const verdict = core.judgeGrant(row, now, zone);
        if (verdict.standing !== "live") continue;
        found.push({
            id: row.id,
            capability: row.capability,
            until: verdict.until,
            counted: row.maxUses !== null
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
    return core.strongest(subject, held.map((grant) => grant.capability));
}

/**
 * Every grant in force over one subject for one account, strongest first. What
 * an action that has to spend one reads.
 *
 * The subject is asked about before the caller is, which is the other way round
 * from how it reads. It is deliberate and it is what makes this cheap enough to
 * sit on an access path: almost nothing is shared, so one indexed query answers
 * "nobody has been given this" and the caller's teams and roles - two more
 * queries - are never looked up at all. Where there are rows there are at most a
 * hundred of them, so matching them to the caller in memory costs nothing.
 */
export async function liveGrants(
    userId: string,
    subject: core.GrantSubject,
    subjectId: string,
    now = new Date()
): Promise<LiveGrant[]> {
    const all = await prisma.accessGrant.findMany({
        where: { subjectType: subject, subjectId },
        select: { ...GRANT_FIELDS, principalType: true, principalId: true }
    });
    if (all.length === 0) return [];

    const principals = await principalsOf(userId);
    const held = new Set([
        `user:${principals.userId}`,
        ...principals.teamIds.map((id) => `team:${id}`),
        ...principals.roleIds.map((id) => `role:${id}`)
    ]);
    const rows = all.filter((row) => held.has(`${row.principalType}:${row.principalId}`));
    if (rows.length === 0) return [];

    const zone = await houseZone(rows);
    return live(rows, zone, now).sort(
        (left, right) =>
            (core.atLeast(subject, right.capability, left.capability) ? 1 : 0) -
            (core.atLeast(subject, left.capability, right.capability) ? 1 : 0)
    );
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
 * Count one use against a grant, if it is counted at all.
 *
 * Bounded in the statement rather than read and then written, so two presses
 * arriving together cannot both find the last use free. A grant that was spent
 * in between simply does not match, and the caller is told - which is the honest
 * answer, since the thing they asked for has not happened yet.
 */
export async function spendGrant(grant: LiveGrant): Promise<boolean> {
    if (!grant.counted) {
        await prisma.accessGrant.update({
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
    readonly principalType: core.GrantPrincipal;
    readonly principalId: string;
    /** Who or what, named. Empty when the team, role or account behind it has
     *  since been deleted, which is what the listing drops. */
    readonly principalName: string;
    /** The organization it came out of, for a team or a role. */
    readonly orgName: string;
    readonly capability: string;
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
    };
    readonly note: string;
    readonly createdAt: string;
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
    now = new Date()
): Promise<GrantView[]> {
    const rows = await prisma.accessGrant.findMany({
        where: { subjectType: subject, subjectId },
        orderBy: { createdAt: "asc" }
    });
    if (rows.length === 0) return [];
    const zone = await houseZone(rows);

    const named = await nameParticipants(rows);
    const views: GrantView[] = [];
    for (const row of rows) {
        const who = named.get(`${row.principalType}:${row.principalId}`);
        if (!who) continue;
        const verdict = core.judgeGrant(row, now, zone);
        views.push({
            id: row.id,
            principalType: row.principalType as core.GrantPrincipal,
            principalId: row.principalId,
            principalName: who.name,
            orgName: who.orgName,
            capability: row.capability,
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
                uses: row.uses
            },
            note: row.note,
            createdAt: row.createdAt.toISOString()
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
                select: { id: true, name: true, email: true }
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
        named.set(`user:${user.id}`, { name: user.name || user.email, orgName: "" });
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
 */
export async function writeGrant(
    subject: core.GrantSubject,
    subjectId: string,
    input: core.AccessGrantInput,
    grantedById: string
): Promise<string> {
    const allowed = core.GRANT_CAPABILITIES[subject] as readonly string[];
    if (!allowed.includes(input.capability)) {
        throw new GrantError("That is not something this can be shared as");
    }
    if (!(await principalExists(input.principalType, input.principalId))) {
        throw new GrantError("That person, team or role no longer exists");
    }
    const held = await prisma.accessGrant.count({ where: { subjectType: subject, subjectId } });
    if (held >= core.MAX_GRANTS_PER_SUBJECT) {
        throw new GrantError("This already has as many shares as it can hold");
    }

    const written = await prisma.accessGrant.create({
        data: {
            subjectType: subject,
            subjectId,
            principalType: input.principalType,
            principalId: input.principalId,
            capability: input.capability,
            startsAt: input.startsAt ? new Date(input.startsAt) : null,
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            days: input.days,
            startMinute: input.startMinute,
            endMinute: input.endMinute,
            timeZone: input.timeZone,
            maxUses: input.maxUses,
            note: input.note,
            grantedById
        },
        select: { id: true }
    });
    return written.id;
}

async function principalExists(kind: core.GrantPrincipal, id: string): Promise<boolean> {
    if (kind === "user") return Boolean(await prisma.user.findUnique({ where: { id } }));
    if (kind === "team") return Boolean(await prisma.team.findUnique({ where: { id } }));
    return Boolean(await prisma.orgRole.findUnique({ where: { id } }));
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

/** Everything one subject hands out, gone - what deleting the subject itself
 *  has to do, since nothing here is a foreign key. */
export async function dropGrantsFor(subject: core.GrantSubject, subjectId: string): Promise<void> {
    await prisma.accessGrant.deleteMany({ where: { subjectType: subject, subjectId } });
}
