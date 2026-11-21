/**
 * Account restriction for spam (ledger row 24): when many different people
 * block or report one account in a short time, it stops reaching new people
 * for a while.
 *
 * Prior art: WhatsApp's account restriction (2024) - many blocks or reports
 * stop an account starting new chats, creating groups and adding people for a
 * while, its existing chats keep working, and a countdown is shown.
 *
 * Worked out from what already happened, like the rest of account standing:
 * blocks (`UserBlock`), message and conversation reports naming the account
 * (`ChatReport.authorId`) and reports about the person (`SafetyCase`). Each
 * person counts once however many times they acted, so one angry person cannot
 * restrict anybody, and a report a moderator settled in the account's favour
 * (`kept`, `dismissed`) does not count. The restriction ends `hours` after the
 * latest of them; nothing has to run to lift it. The thresholds are the
 * instance's (`moderation-policy.ts`).
 *
 * It reaches only what is new: a one-to-one with somebody they have no
 * conversation with, a new group, adding people. Every conversation that
 * already exists keeps working, which is the point - a restriction that cut a
 * nurse off from the ward chat because strangers reported her would be worse
 * than the spam.
 */

import { prisma } from "@polaris/db";
import { ChatRuleError } from "./access";
import { moderationPolicy } from "./moderation-policy";
import type { RestrictionPolicy } from "./moderation-policy-rules";

/** How many rows of each kind are read at most; far past any threshold. */
const READ_CAP = 1000;

export interface SpamRestriction {
    /** When it lifts by itself. */
    readonly until: Date;
    /** How many different people blocked or reported the account. */
    readonly people: number;
}

interface Signal {
    readonly by: string;
    readonly at: Date;
}

/** Pure: the restriction a set of signals amounts to now, if any. */
export function restrictionFrom(
    signals: readonly Signal[],
    policy: RestrictionPolicy,
    now: Date = new Date()
): SpamRestriction | null {
    if (!policy.enabled) return null;
    const since = now.getTime() - policy.windowDays * 24 * 60 * 60 * 1000;
    const latestBy = new Map<string, number>();
    for (const signal of signals) {
        const at = signal.at.getTime();
        if (at < since || at > now.getTime()) continue;
        latestBy.set(signal.by, Math.max(latestBy.get(signal.by) ?? 0, at));
    }
    if (latestBy.size < policy.threshold) return null;
    const latest = Math.max(...latestBy.values());
    const until = new Date(latest + policy.hours * 60 * 60 * 1000);
    return until.getTime() > now.getTime() ? { until, people: latestBy.size } : null;
}

/** The restriction on one account now, or null. */
export async function spamRestrictionFor(userId: string, now: Date = new Date()): Promise<SpamRestriction | null> {
    const policy = (await moderationPolicy()).restriction;
    if (!policy.enabled) return null;
    const since = new Date(now.getTime() - policy.windowDays * 24 * 60 * 60 * 1000);
    const [blocks, reports, cases] = await Promise.all([
        prisma.userBlock.findMany({
            where: { blockedId: userId, createdAt: { gte: since } },
            select: { blockerId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: READ_CAP
        }),
        prisma.chatReport.findMany({
            where: { authorId: userId, createdAt: { gte: since }, status: { not: "kept" } },
            select: { reporterId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: READ_CAP
        }),
        prisma.safetyCase.findMany({
            where: {
                subjectId: userId,
                reporterId: { not: null },
                createdAt: { gte: since },
                status: { not: "dismissed" }
            },
            select: { reporterId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: READ_CAP
        })
    ]);
    const signals: Signal[] = [
        ...blocks.map((row) => ({ by: row.blockerId, at: row.createdAt })),
        ...reports.map((row) => ({ by: row.reporterId, at: row.createdAt })),
        ...cases.flatMap((row) => (row.reporterId ? [{ by: row.reporterId, at: row.createdAt }] : []))
    ].filter((signal) => signal.by !== userId);
    return restrictionFrom(signals, policy, now);
}

/** Whole hours until it lifts, at least one, for the sentence that says so. */
export function restrictionHoursLeft(restriction: SpamRestriction, now: number = Date.now()): number {
    return Math.max(1, Math.ceil((restriction.until.getTime() - now) / (60 * 60 * 1000)));
}

/** Where the action reaches: the organization it happens in, and who it adds. */
export interface Reach {
    readonly orgId: string | null;
    readonly targets: readonly string[];
}

/** What is known about the actor and the people reached inside `orgId`. */
export interface OrgStanding {
    /** The actor owns the organization or holds its admin role: a grant the
     *  organization made on purpose. */
    readonly actorAdmin: boolean;
    /** The actor is an unrestricted member (or the owner). */
    readonly actorMember: boolean;
    /** Which targets are unrestricted members (or the owner). */
    readonly members: ReadonlySet<string>;
}

/**
 * Pure: whether a restricted account may still do this. Only inside an
 * organization: its owner and administrators, granted that by the
 * organization, keep running its conversations, and a member adding only
 * fellow members reaches nobody new - the organization already put them
 * together. Anywhere else, or with one outsider among the targets, no.
 */
export function exemptFromRestriction(reach: Reach, standing: OrgStanding | null): boolean {
    if (!reach.orgId || !standing) return false;
    if (standing.actorAdmin) return true;
    return standing.actorMember && reach.targets.length > 0 && reach.targets.every((id) => standing.members.has(id));
}

async function orgStanding(actorId: string, reach: Reach): Promise<OrgStanding | null> {
    if (!reach.orgId) return null;
    const ids = [...new Set([actorId, ...reach.targets])];
    const [org, rows] = await Promise.all([
        prisma.organization.findUnique({ where: { id: reach.orgId }, select: { ownerId: true } }),
        prisma.organizationMember.findMany({
            where: { orgId: reach.orgId, userId: { in: ids }, restricted: false },
            select: { userId: true, role: true }
        })
    ]);
    if (!org) return null;
    const members = new Set(rows.map((row) => row.userId));
    members.add(org.ownerId);
    const actorRole = rows.find((row) => row.userId === actorId)?.role;
    return {
        actorAdmin: org.ownerId === actorId || actorRole === "owner" || actorRole === "admin",
        actorMember: members.has(actorId),
        members
    };
}

/**
 * Refuse something that reaches new people while the account is restricted.
 * `reach` names where it happens, for the organization exemptions above; it
 * is only asked once the account turns out to be restricted, so the common
 * path costs nothing extra.
 *
 * A lookup that fails lets the action through and is logged: this guards
 * against spam, and an outage in it must never stop somebody starting a
 * conversation they are entitled to.
 */
export async function requireUnrestricted(userId: string, reach?: () => Promise<Reach>): Promise<void> {
    let restriction: SpamRestriction | null;
    try {
        restriction = await spamRestrictionFor(userId);
        if (restriction && reach) {
            const where = await reach();
            if (exemptFromRestriction(where, await orgStanding(userId, where))) return;
        }
    } catch (error) {
        console.error("[chat] could not check the spam restriction:", error);
        return;
    }
    if (!restriction) return;
    throw new ChatRuleError({ key: "errors.spamRestricted", params: { hours: restrictionHoursLeft(restriction) } });
}
