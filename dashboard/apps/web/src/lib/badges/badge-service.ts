/**
 * Profile badges on the server: what somebody has earned, who may see it, and
 * the administrator's custom badges.
 *
 * Progress is read from what Polaris already records, one bounded query per
 * ladder and each served by an index on the person. Nothing is denormalized:
 * the first time a level is seen reached, its day is written to `BadgeUnlock`
 * and never moved, so the date survives the activity behind it (a deleted
 * message does not take a level back).
 *
 * Rarity is counted over the whole instance by the scheduled sweep and kept as
 * one setting, so drawing a badge never counts the table behind it.
 *
 * Every read of somebody else's badges goes through `badgesFor`, which applies
 * the account's `badges` privacy rule, each badge's own rule, and hiding. Only
 * the owner's own read counts activity and records levels; anybody else reads
 * what is already recorded, so opening a profile never counts or writes.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { prisma, Prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    assertOwnPrivacyLists,
    maySee,
    ruleAllows,
    type PrivacyViewer
} from "@/lib/privacy-service";

/** A refusal whose sentence may be shown to the person who caused it. */
export class BadgeError extends Error {}

const DAY_MS = 86_400_000;
/** A person links a handful of game players; more than this is not read. */
const MOST_PLAYER_LINKS = 50;

export type BadgeValues = Record<core.BadgeLadderId, number>;

/** The raw activity each ladder is measured by, for one person. */
export async function activityValues(userId: string, now = new Date()): Promise<BadgeValues> {
    const [user, messages, callSeconds, tasks, arcade, serverSeconds] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
        prisma.chatMessage.count({
            where: {
                authorId: userId,
                deletedAt: null,
                webhookId: null,
                kind: { notIn: ["system", "call"] }
            }
        }),
        callTime(userId),
        prisma.task.count({
            where: { completedAt: { not: null }, assignees: { some: { userId } } }
        }),
        prisma.arcadeSessionPlayer.count({ where: { userId } }),
        serverTime(userId)
    ]);
    return {
        tenure: user ? Math.floor((now.getTime() - user.createdAt.getTime()) / DAY_MS) : 0,
        messages,
        calls: Math.floor(callSeconds / 60),
        tasks,
        arcade,
        servers: Math.floor(serverSeconds / 3600)
    };
}

/** Seconds spent admitted to calls and meetings, an open seat counted to its last heartbeat. */
async function callTime(userId: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ seconds: number | null }[]>`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE("leftAt", "lastSeenAt") - "joinedAt"))), 0)::float8 AS seconds
        FROM "MeetingParticipant"
        WHERE "userId" = ${userId}::uuid AND "admission" = 'admitted'`;
    return Math.max(0, Number(rows[0]?.seconds ?? 0));
}

/** Seconds on game servers, through the players this person is linked to. */
async function serverTime(userId: string): Promise<number> {
    const links = await prisma.gamePlayerLink.findMany({
        where: { userId },
        select: { installedAppId: true, player: true },
        take: MOST_PLAYER_LINKS
    });
    if (links.length === 0) return 0;
    const matches = links.map(
        (link) =>
            Prisma.sql`("installedAppId" = ${link.installedAppId}::uuid AND ("name" = ${link.player} OR "playerId" = ${link.player}))`
    );
    const rows = await prisma.$queryRaw<{ seconds: number | null }[]>`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE("leftAt", "joinedAt") - "joinedAt"))), 0)::float8 AS seconds
        FROM "GamePlayerSession"
        WHERE ${Prisma.join(matches, " OR ")}`;
    return Math.max(0, Number(rows[0]?.seconds ?? 0));
}

export interface BadgeLevelView {
    level: number;
    name: core.BadgeLevelName;
    threshold: number;
    unlockedAt: string | null;
}

/** One badge as every screen draws it. Dates are ISO strings so it crosses to the client. */
export interface BadgeView {
    key: string;
    kind: core.BadgeKind;
    /** The ladder id, "staff", or "custom". */
    category: string;
    /** Which drawn icon: a ladder id, "staff", or a custom badge's icon. */
    icon: string;
    /** Only custom badges carry their own words; the others are in the catalogs. */
    name: string | null;
    description: string | null;
    owned: boolean;
    level: number;
    top: number;
    levelName: core.BadgeLevelName | null;
    unlockedAt: string | null;
    /** Percent of the people on this instance holding this badge at this level. */
    rarity: number;
    unit: string | null;
    progress: { value: number; next: number | null; fraction: number } | null;
    levels: BadgeLevelView[];
}

export interface BadgeArrangement {
    badge: string;
    hidden: boolean;
    audience: core.PrivacyAudience | null;
    listId: string | null;
    people: string[];
}

/**
 * Everything one person has and could have, levels recorded as they go.
 * Owned badges first, then the ladders not started yet.
 */
export async function evaluateBadges(userId: string, now = new Date()): Promise<BadgeView[]> {
    const [basis, values] = await Promise.all([badgeBasis(userId), activityValues(userId, now)]);
    if (!basis.user) return [];
    const reached = await recordUnlocks(userId, basis.user, values, basis.unlocks, now);
    return badgeViews(basis.user, basis, reached, now, (id) => {
        const progress = core.ladderProgress(core.BADGE_LADDERS[id].thresholds, values[id]);
        return { level: progress.level, progress };
    });
}

/**
 * What one person holds as recorded so far, for anybody but its owner: the
 * levels already written by the sweep or by the owner's own screens, without
 * counting their activity or writing anything. Tenure needs no counting, so it
 * is read from the account's age; how far anybody is towards a next level is
 * left to its owner.
 */
export async function recordedBadges(userId: string, now = new Date()): Promise<BadgeView[]> {
    const basis = await badgeBasis(userId);
    const user = basis.user;
    if (!user) return [];
    const reached = new Map(
        basis.unlocks.map((row) => [`${row.badge}#${row.level}`, row.unlockedAt])
    );
    return badgeViews(user, basis, reached, now, (id) => {
        const { thresholds } = core.BADGE_LADDERS[id];
        if (id === "tenure") {
            const days = Math.floor((now.getTime() - user.createdAt.getTime()) / DAY_MS);
            return { level: core.ladderProgress(thresholds, days).level, progress: null };
        }
        const key = core.ladderKey(id);
        const recorded = basis.unlocks
            .filter((row) => row.badge === key)
            .reduce((most, row) => Math.max(most, row.level), 0);
        return { level: Math.min(recorded, thresholds.length), progress: null };
    });
}

type BasisUser = { isAdmin: boolean; createdAt: Date };
type GrantRow = {
    grantedAt: Date;
    badge: { id: string; name: string; description: string; icon: string };
};
interface BadgeBasis {
    user: BasisUser | null;
    grants: GrantRow[];
    unlocks: UnlockRow[];
    rarity: Rarity;
}
type LadderState = { level: number; progress: core.LadderProgress | null };

function badgeBasis(userId: string): Promise<BadgeBasis> {
    return Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: { isAdmin: true, createdAt: true }
        }),
        prisma.badgeGrant.findMany({
            where: { userId },
            select: {
                grantedAt: true,
                badge: { select: { id: true, name: true, description: true, icon: true } }
            },
            orderBy: { grantedAt: "asc" },
            take: core.MOST_BADGE_PREFERENCES
        }),
        unlocksOf(userId),
        storedRarity()
    ]).then(([user, grants, unlocks, rarity]) => ({ user, grants, unlocks, rarity }));
}

function badgeViews(
    user: BasisUser,
    { grants, rarity }: BadgeBasis,
    reached: ReadonlyMap<string, Date>,
    now: Date,
    stateOf: (id: core.BadgeLadderId) => LadderState
): BadgeView[] {
    const dateOf = (badge: string, level: number, fallback = now): Date =>
        reached.get(`${badge}#${level}`) ?? fallback;

    const staff = user.isAdmin ? dateOf(core.STAFF_BADGE, 1) : null;
    const ladders = core.BADGE_LADDER_IDS.map((id) => {
        const ladder = core.BADGE_LADDERS[id];
        const state = stateOf(id);
        const key = core.ladderKey(id);
        const levels = ladder.thresholds.map((threshold, index) => ({
            level: index + 1,
            name: core.BADGE_LEVELS[index]!,
            threshold,
            unlockedAt:
                index < state.level
                    ? dateOf(
                          key,
                          index + 1,
                          id === "tenure" ? tenureDay(user.createdAt, threshold, now) : now
                      ).toISOString()
                    : null
        }));
        return { id, key, ladder, state, levels };
    });

    const views: BadgeView[] = [];
    if (staff) {
        views.push({
            key: core.STAFF_BADGE,
            kind: "staff",
            category: "staff",
            icon: "staff",
            name: null,
            description: null,
            owned: true,
            level: 1,
            top: 1,
            levelName: null,
            unlockedAt: staff.toISOString(),
            rarity: rarity.staff,
            unit: null,
            progress: null,
            levels: []
        });
    }
    for (const grant of grants) {
        views.push({
            key: core.customKey(grant.badge.id),
            kind: "custom",
            category: "custom",
            icon: grant.badge.icon,
            name: grant.badge.name,
            description: grant.badge.description,
            owned: true,
            level: 1,
            top: 1,
            levelName: null,
            unlockedAt: grant.grantedAt.toISOString(),
            rarity: rarity.custom[grant.badge.id] ?? 0,
            unit: null,
            progress: null,
            levels: []
        });
    }
    const ladderView = (entry: (typeof ladders)[number]): BadgeView => ({
        key: entry.key,
        kind: "ladder",
        category: entry.id,
        icon: entry.id,
        name: null,
        description: null,
        owned: entry.state.level > 0,
        level: entry.state.level,
        top: entry.ladder.thresholds.length,
        levelName: core.levelName(entry.state.level),
        unlockedAt: entry.levels[entry.state.level - 1]?.unlockedAt ?? null,
        rarity: rarity.ladder[`${entry.key}#${Math.max(1, entry.state.level)}`] ?? 0,
        unit: entry.ladder.unit,
        progress: entry.state.progress && {
            value: entry.state.progress.value,
            next: entry.state.progress.next,
            fraction: entry.state.progress.fraction
        },
        levels: entry.levels
    });
    views.push(...ladders.filter((entry) => entry.state.level > 0).map(ladderView));
    views.push(...ladders.filter((entry) => entry.state.level === 0).map(ladderView));
    return views;
}

type UnlockRow = { badge: string; level: number; unlockedAt: Date };

function unlocksOf(userId: string): Promise<UnlockRow[]> {
    return prisma.badgeUnlock.findMany({
        where: { userId },
        select: { badge: true, level: true, unlockedAt: true }
    });
}

/**
 * Write the day of every level this person has reached and that is not
 * recorded yet, and answer every recorded day by `badge#level`. A level is
 * written once and never moved or removed. A tenure level carries the day it
 * was really reached, which the account's age says exactly; every other level
 * is dated when it is first noticed.
 */
async function recordUnlocks(
    userId: string,
    user: { isAdmin: boolean; createdAt: Date },
    values: BadgeValues,
    known: readonly UnlockRow[],
    now: Date
): Promise<Map<string, Date>> {
    const reached = new Map(known.map((row) => [`${row.badge}#${row.level}`, row.unlockedAt]));
    const due: UnlockRow[] = user.isAdmin
        ? [{ badge: core.STAFF_BADGE, level: 1, unlockedAt: now }]
        : [];
    for (const id of core.BADGE_LADDER_IDS) {
        const { thresholds } = core.BADGE_LADDERS[id];
        const { level } = core.ladderProgress(thresholds, values[id]);
        for (let at = 1; at <= level; at++) {
            const unlockedAt =
                id === "tenure" ? tenureDay(user.createdAt, thresholds[at - 1]!, now) : now;
            due.push({ badge: core.ladderKey(id), level: at, unlockedAt });
        }
    }
    const missing = due.filter((row) => !reached.has(`${row.badge}#${row.level}`));
    if (missing.length > 0) {
        await prisma.badgeUnlock.createMany({
            data: missing.map((row) => ({ userId, ...row })),
            skipDuplicates: true
        });
        for (const row of missing) reached.set(`${row.badge}#${row.level}`, row.unlockedAt);
    }
    return reached;
}

/** The day an account made at `createdAt` turned `days` old, never later than now. */
function tenureDay(createdAt: Date, days: number, now: Date): Date {
    return new Date(Math.min(now.getTime(), createdAt.getTime() + days * DAY_MS));
}

/** People one sweep pass reaches, a batch at a time. */
const SWEEP_BATCH = 200;
const SWEEP_BATCHES = 5;
const SWEEP_CURSOR = "badges.unlockSweepCursor";
const RARITY_KEY = "badges.rarity";

/**
 * Record the levels everybody has reached, not only the people whose profile
 * somebody opened - rarity is counted from these rows, so it has to see the
 * whole instance. A pass walks people in id order from where the last one
 * stopped, a bounded number of batches, and starts over once it reaches the
 * end, then counts rarity from what is recorded and keeps it for every screen
 * to read. Re-running it is harmless: a level already written is left alone.
 */
export async function sweepBadgeUnlocks(now = new Date()): Promise<{ people: number }> {
    let cursor = await getSetting(SWEEP_CURSOR);
    let people = 0;
    for (let batch = 0; batch < SWEEP_BATCHES; batch++) {
        const users = await prisma.user.findMany({
            where: cursor ? { id: { gt: cursor } } : {},
            orderBy: { id: "asc" },
            take: SWEEP_BATCH,
            select: { id: true, isAdmin: true, createdAt: true }
        });
        for (const user of users) {
            // One person whose activity cannot be read is not a reason to stop
            // at them on every pass: they are tried again next time round.
            await Promise.all([activityValues(user.id, now), unlocksOf(user.id)])
                .then(([values, known]) => recordUnlocks(user.id, user, values, known, now))
                .catch((error) => console.error("polaris: could not record badge levels:", error));
        }
        people += users.length;
        cursor = users.length === SWEEP_BATCH ? users[users.length - 1]!.id : null;
        if (!cursor) break;
    }
    await setSetting(SWEEP_CURSOR, cursor);
    await setSetting(RARITY_KEY, JSON.stringify(await countRarity()));
    return { people };
}

const percentSchema = z.number().finite().min(0).max(100);
const raritySchema = z.object({
    staff: percentSchema,
    ladder: z.record(z.string(), percentSchema),
    custom: z.record(z.string(), percentSchema)
});
type Rarity = z.infer<typeof raritySchema>;
const NO_RARITY: Rarity = { staff: 0, ladder: {}, custom: {} };

/** Holders over people for every badge on the instance: four grouped reads, whatever the count. */
async function countRarity(): Promise<Rarity> {
    const [people, admins, levels, grants] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isAdmin: true } }),
        prisma.badgeUnlock.groupBy({
            by: ["badge", "level"],
            where: { badge: { in: core.BADGE_LADDER_IDS.map((id) => core.ladderKey(id)) } },
            _count: { _all: true }
        }),
        prisma.badgeGrant.groupBy({ by: ["badgeId"], _count: { _all: true } })
    ]);
    return {
        staff: core.rarityPercent(admins, people),
        ladder: Object.fromEntries(
            levels.map((row) => [
                `${row.badge}#${row.level}`,
                core.rarityPercent(row._count._all, people)
            ])
        ),
        custom: Object.fromEntries(
            grants.map((row) => [row.badgeId, core.rarityPercent(row._count._all, people)])
        )
    };
}

/** What the last sweep counted; before the first one, nobody holds anything. */
async function storedRarity(): Promise<Rarity> {
    const raw = await getSetting(RARITY_KEY);
    if (!raw) return NO_RARITY;
    try {
        const parsed = raritySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : NO_RARITY;
    } catch {
        return NO_RARITY;
    }
}

/** How this person arranged their badges, in their order. */
export async function arrangementOf(userId: string): Promise<BadgeArrangement[]> {
    const rows = await prisma.badgePreference.findMany({
        where: { userId },
        orderBy: { position: "asc" },
        select: { badge: true, hidden: true, audience: true, listId: true, people: true },
        take: core.MOST_BADGE_PREFERENCES
    });
    return rows.map((row) => ({
        badge: row.badge,
        hidden: row.hidden,
        audience: storedAudience(row.audience),
        listId: row.listId,
        people: row.people
    }));
}

function storedAudience(value: string | null): core.PrivacyAudience | null {
    const parsed = core.privacyRuleSchema.shape.audience.safeParse(value ?? undefined);
    return value !== null && parsed.success ? parsed.data : null;
}

export interface BadgesForViewer {
    /** Owned badges the viewer may see, in their owner's order. */
    shown: BadgeView[];
    /** The owner only: badges not unlocked yet. */
    available: BadgeView[];
    /** The owner only: how they arranged them. */
    arrangement: BadgeArrangement[] | null;
}

/**
 * The badges one viewer may see of one person. The owner sees all of theirs,
 * hidden ones included, plus what is left to unlock. Anybody else needs the
 * account's `badges` rule to let them through, then each badge's own rule, and
 * never sees a hidden one - not even an administrator, since hiding is a choice
 * about the profile rather than a secret.
 */
export async function badgesFor(
    subjectId: string,
    viewer: PrivacyViewer | null
): Promise<BadgesForViewer> {
    const asking: PrivacyViewer = viewer ?? { id: "", isAdmin: false };
    const own = asking.id === subjectId;
    if (!own && !(await maySee(subjectId, "badges", asking))) {
        return { shown: [], available: [], arrangement: null };
    }
    const [views, arrangement] = await Promise.all([
        own ? evaluateBadges(subjectId) : recordedBadges(subjectId),
        arrangementOf(subjectId)
    ]);
    const byKey = new Map(arrangement.map((row) => [row.badge, row]));
    const positions = new Map(arrangement.map((row, index) => [row.badge, index]));
    const owned = core.orderBadges(
        views.filter((view) => view.owned),
        positions
    );
    if (own) {
        return { shown: owned, available: views.filter((view) => !view.owned), arrangement };
    }

    const shown: BadgeView[] = [];
    for (const view of owned) {
        const pref = byKey.get(view.key);
        if (pref?.hidden) continue;
        if (pref?.audience) {
            const rule = { audience: pref.audience, listId: pref.listId, people: pref.people };
            if (!(await ruleAllows(asking, subjectId, rule))) continue;
        }
        shown.push(view);
    }
    return { shown, available: [], arrangement: null };
}

/**
 * The badges drawn in a row beside somebody's name, on every profile surface
 * that is not the owner's own page: what `badgesFor` lets this viewer see,
 * minus the ones the owner hid - which the owner's own answer still carries,
 * and pressing your own name is how you check what everybody else is shown. A
 * failure is no badges, never no profile.
 */
export async function badgesBesideName(
    subjectId: string,
    viewer: PrivacyViewer | null
): Promise<BadgeView[]> {
    const answer = await badgesFor(subjectId, viewer).catch(() => null);
    if (!answer) return [];
    const hidden = new Set(
        (answer.arrangement ?? []).filter((row) => row.hidden).map((row) => row.badge)
    );
    return answer.shown.filter((badge) => !hidden.has(badge.key));
}

/**
 * Replace one person's arrangement. The order of the list is the order on the
 * profile. A saved list named by a badge must be theirs; people are kept as
 * given, as a privacy list's are.
 */
export async function saveArrangement(userId: string, input: unknown): Promise<void> {
    const parsed = core.badgePreferencesSchema.safeParse(input);
    if (!parsed.success)
        throw new BadgeError(parsed.error.issues[0]?.message ?? "Those badges could not be saved");
    const rows = parsed.data.map((row) => {
        const needsList = row.audience !== null && core.audienceNeedsList(row.audience);
        return {
            badge: row.badge,
            hidden: row.hidden,
            audience: row.audience,
            listId: needsList ? row.listId : null,
            people: needsList && row.listId === null ? row.people : []
        };
    });
    await assertOwnPrivacyLists(
        userId,
        rows.flatMap((row) => (row.listId ? [row.listId] : []))
    );
    await prisma.$transaction([
        prisma.badgePreference.deleteMany({
            where: { userId, badge: { notIn: rows.map((row) => row.badge) } }
        }),
        ...rows.map((row, position) =>
            prisma.badgePreference.upsert({
                where: { userId_badge: { userId, badge: row.badge } },
                create: { userId, position, ...row },
                update: { position, ...row }
            })
        )
    ]);
}

// ---------------------------------------------------------------------------
// Custom badges: administrators only. Every function checks the actor itself,
// so a caller that forgot `requireAdmin` still cannot hand one out.
// ---------------------------------------------------------------------------

export interface BadgeActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

function assertAdmin(actor: BadgeActor): void {
    if (!actor.isAdmin) throw new BadgeError("Only an administrator can manage badges");
}

export interface BadgeDefinitionView {
    id: string;
    name: string;
    description: string;
    icon: core.BadgeIcon;
    holders: number;
}

const MOST_DEFINITIONS = 200;

export async function listDefinitions(actor: BadgeActor): Promise<BadgeDefinitionView[]> {
    assertAdmin(actor);
    const rows = await prisma.badgeDefinition.findMany({
        orderBy: { createdAt: "asc" },
        take: MOST_DEFINITIONS,
        select: {
            id: true,
            name: true,
            description: true,
            icon: true,
            _count: { select: { grants: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        icon: (core.BADGE_ICONS as readonly string[]).includes(row.icon)
            ? (row.icon as core.BadgeIcon)
            : "star",
        holders: row._count.grants
    }));
}

function definitionInput(input: unknown): core.BadgeDefinitionInput {
    const parsed = core.badgeDefinitionSchema.safeParse(input);
    if (!parsed.success)
        throw new BadgeError(parsed.error.issues[0]?.message ?? "That badge is not valid");
    return parsed.data;
}

export async function createDefinition(actor: BadgeActor, input: unknown): Promise<string> {
    assertAdmin(actor);
    const data = definitionInput(input);
    const count = await prisma.badgeDefinition.count();
    if (count >= MOST_DEFINITIONS)
        throw new BadgeError("This instance already has as many badges as it can hold");
    const row = await prisma.badgeDefinition.create({
        data: { ...data, createdById: actor.id },
        select: { id: true }
    });
    await recordAudit({
        actorId: actor.id,
        action: "badge.create",
        targetType: "badge",
        targetId: row.id,
        metadata: { name: data.name }
    });
    return row.id;
}

export async function updateDefinition(
    actor: BadgeActor,
    id: unknown,
    input: unknown
): Promise<void> {
    assertAdmin(actor);
    const badgeId = uuid(id);
    const data = definitionInput(input);
    const { count } = await prisma.badgeDefinition.updateMany({ where: { id: badgeId }, data });
    if (count === 0) throw new BadgeError("That badge no longer exists");
    await recordAudit({
        actorId: actor.id,
        action: "badge.update",
        targetType: "badge",
        targetId: badgeId,
        metadata: { name: data.name }
    });
}

/** Deleting a badge takes it from everybody who had it, and from their arrangements. */
export async function deleteDefinition(actor: BadgeActor, id: unknown): Promise<void> {
    assertAdmin(actor);
    const badgeId = uuid(id);
    const [, removed] = await prisma.$transaction([
        prisma.badgePreference.deleteMany({ where: { badge: core.customKey(badgeId) } }),
        prisma.badgeDefinition.deleteMany({ where: { id: badgeId } })
    ]);
    if (removed.count > 0) {
        await recordAudit({
            actorId: actor.id,
            action: "badge.delete",
            targetType: "badge",
            targetId: badgeId
        });
    }
}

/** Give a badge; answers whether the person did not hold it already. */
export async function grantBadge(
    actor: BadgeActor,
    id: unknown,
    userId: unknown
): Promise<boolean> {
    assertAdmin(actor);
    const badgeId = uuid(id);
    const holder = uuid(userId);
    const [badge, person] = await Promise.all([
        prisma.badgeDefinition.findUnique({ where: { id: badgeId }, select: { id: true } }),
        prisma.user.findUnique({ where: { id: holder }, select: { id: true } })
    ]);
    if (!badge) throw new BadgeError("That badge no longer exists");
    if (!person) throw new BadgeError("That person no longer exists");
    const { count } = await prisma.badgeGrant.createMany({
        data: [{ badgeId, userId: holder, grantedById: actor.id }],
        skipDuplicates: true
    });
    if (count > 0) {
        await recordAudit({
            actorId: actor.id,
            action: "badge.grant",
            targetType: "user",
            targetId: holder,
            metadata: { badgeId }
        });
    }
    return count > 0;
}

export async function revokeBadge(actor: BadgeActor, id: unknown, userId: unknown): Promise<void> {
    assertAdmin(actor);
    const badgeId = uuid(id);
    const holder = uuid(userId);
    const [revoked] = await prisma.$transaction([
        prisma.badgeGrant.deleteMany({ where: { badgeId, userId: holder } }),
        prisma.badgePreference.deleteMany({
            where: { userId: holder, badge: core.customKey(badgeId) }
        })
    ]);
    if (revoked.count > 0) {
        await recordAudit({
            actorId: actor.id,
            action: "badge.revoke",
            targetType: "user",
            targetId: holder,
            metadata: { badgeId }
        });
    }
}

export interface BadgeHolder {
    id: string;
    name: string;
    username: string | null;
    grantedAt: string;
}

export interface BadgeHoldersPage {
    holders: BadgeHolder[];
    /** Where the next page starts, or null when this one is the last. */
    next: string | null;
}

const HOLDERS_PAGE = 50;

const holdersQuerySchema = z.object({
    query: z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().max(100))
        .default(""),
    cursor: z.string().uuid().nullable().default(null)
});

/**
 * One page of the people holding a badge, newest first, narrowed to a name or
 * username when a search is given. Each page starts after the grant the last
 * one ended on.
 */
export async function holdersOf(
    actor: BadgeActor,
    id: unknown,
    options: unknown = {}
): Promise<BadgeHoldersPage> {
    assertAdmin(actor);
    const badgeId = uuid(id);
    const parsed = holdersQuerySchema.safeParse(options ?? {});
    if (!parsed.success) throw new BadgeError("That search is not valid");
    const { query, cursor } = parsed.data;
    const named = query
        ? {
              user: {
                  OR: [
                      { name: { contains: query, mode: "insensitive" as const } },
                      { username: { contains: query, mode: "insensitive" as const } }
                  ]
              }
          }
        : {};
    const rows = await prisma.badgeGrant.findMany({
        where: { badgeId, ...named },
        orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
        take: HOLDERS_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
            id: true,
            grantedAt: true,
            user: { select: { id: true, name: true, username: true } }
        }
    });
    const page = rows.slice(0, HOLDERS_PAGE);
    return {
        holders: page.map((row) => ({ ...row.user, grantedAt: row.grantedAt.toISOString() })),
        next: rows.length > HOLDERS_PAGE ? page[page.length - 1]!.id : null
    };
}

function uuid(value: unknown): string {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) throw new BadgeError("That badge or person is not valid");
    return parsed.data;
}
