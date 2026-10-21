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
import { createHash, randomBytes } from "node:crypto";
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
        // A link names nobody: what the screen says for it is its note.
        const who =
            row.principalType === core.LINK_PRINCIPAL
                ? { name: "", orgName: "" }
                : named.get(`${row.principalType}:${row.principalId}`);
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
    if (!(await principalExists(input.principalType, input.principalId, orgIds))) {
        throw new GrantError(
            input.principalType === "user"
                ? "That person no longer exists"
                : "That team or role is not one this can be shared with"
        );
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
        },
        select: { id: true }
    });
    return written.id;
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
    subject: (typeof core.GRANT_LINK_SUBJECTS)[number],
    subjectId: string,
    input: core.GrantLinkInput,
    grantedById: string
): Promise<{ id: string; token: string }> {
    const allowed = core.GRANT_CAPABILITIES[subject] as readonly string[];
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
    if (!LINK_TOKEN.test(token)) return null;
    const row = await prisma.accessGrant.findFirst({
        where: { principalType: core.LINK_PRINCIPAL, principalId: linkPrincipalId(token) },
        select: { ...GRANT_FIELDS, note: true }
    });
    if (!row) return null;
    const zone = await houseZone([row]);
    const verdict = core.judgeGrant(row, now, zone);
    const base = { subjectType: row.subjectType, subjectId: row.subjectId, note: row.note };
    if (verdict.standing !== "live") return { standing: verdict.standing, ...base };
    const [grant] = live([row], zone, now);
    return grant ? { standing: "live", grant, ...base } : { standing: "spent", ...base };
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
export async function dropGrantsFor(subject: core.GrantSubject, subjectId: string): Promise<void> {
    await prisma.accessGrant.deleteMany({ where: { subjectType: subject, subjectId } });
}
