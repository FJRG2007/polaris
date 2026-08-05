/**
 * How much agent work something may do, and whether it has already done it.
 *
 * Agent runs spend real money at a provider, and until now nothing bounded that:
 * one repository with a chatty automation could empty an account, and the first
 * anybody knew was the bill. So an administrator can set ceilings, and a
 * dispatch that would cross one is refused with the reason rather than started.
 *
 * Every rule that applies has to be satisfied, which means the most restrictive
 * one wins without anything having to rank them - there is no precedence to
 * learn and no order to get wrong.
 *
 * A rule on a role or a group is per member. A role is how an administrator sets
 * the same limit for forty people; a shared pot would instead mean one person's
 * Monday could stop everybody else's Tuesday, which nobody could see coming.
 */

import { prisma } from "@polaris/db";
import {
    LIMIT_PERIOD_LABELS,
    type LimitMetric,
    type LimitPeriod,
    type LimitSubject
} from "@polaris/core";

const PERIOD_MS: Record<LimitPeriod, number> = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000
};

/** Counted as a rolling window rather than from a calendar boundary: a calendar
 *  month lets a month's budget be spent twice across a month end. */
function since(period: LimitPeriod): Date {
    return new Date(Date.now() - PERIOD_MS[period]);
}

export interface UsageLimitView {
    id: string;
    subjectType: LimitSubject;
    subjectId: string;
    metric: LimitMetric;
    period: LimitPeriod;
    amount: number;
}

export async function listUsageLimits(): Promise<UsageLimitView[]> {
    const rows = await prisma.agentUsageLimit.findMany({
        orderBy: [{ subjectType: "asc" }, { subjectId: "asc" }]
    });
    return rows.map((row) => ({
        id: row.id,
        subjectType: row.subjectType as LimitSubject,
        subjectId: row.subjectId,
        metric: row.metric as LimitMetric,
        period: row.period as LimitPeriod,
        amount: row.amount
    }));
}

export async function saveUsageLimit(input: Omit<UsageLimitView, "id">): Promise<void> {
    // `everyone` carries no subject, and storing one would make two rules that
    // mean the same thing look different to the unique index.
    const subjectId = input.subjectType === "everyone" ? "" : input.subjectId;
    await prisma.agentUsageLimit.upsert({
        where: {
            subjectType_subjectId_metric_period: {
                subjectType: input.subjectType,
                subjectId,
                metric: input.metric,
                period: input.period
            }
        },
        create: { ...input, subjectId },
        update: { amount: input.amount }
    });
}

export async function deleteUsageLimit(id: string): Promise<void> {
    await prisma.agentUsageLimit.deleteMany({ where: { id } });
}

/** A refusal, in the words the run row will carry. */
export interface LimitVerdict {
    allowed: boolean;
    reason?: string;
}

/**
 * Whether this run may start.
 *
 * Reads nothing when the deployment has set no rules, which is the common case
 * and the one that must stay free. Where there are rules, only the ones that
 * apply to this run are counted - a rule about another repository costs nothing
 * to skip.
 */
export async function checkUsageLimits(input: {
    ownerId: string;
    repoFullName: string;
}): Promise<LimitVerdict> {
    const rules = await prisma.agentUsageLimit.findMany();
    if (rules.length === 0) return { allowed: true };

    const owner = (await roleAndGroupIds(input.ownerId)) ?? { roles: [], groups: [] };
    const org = (input.repoFullName.split("/")[0] ?? "").toLowerCase();

    for (const rule of rules) {
        const subject = rule.subjectType as LimitSubject;
        const applies =
            subject === "everyone" ||
            (subject === "user" && rule.subjectId === input.ownerId) ||
            (subject === "role" && owner.roles.includes(rule.subjectId)) ||
            (subject === "group" && owner.groups.includes(rule.subjectId)) ||
            (subject === "repo" && rule.subjectId.toLowerCase() === input.repoFullName.toLowerCase()) ||
            (subject === "org" && rule.subjectId.toLowerCase() === org);
        if (!applies) continue;

        // Counted over whatever the rule is ABOUT, which for a role or a group is
        // the one person it is being applied to - see the note at the top.
        const scope =
            subject === "repo"
                ? { repo: { repoFullName: rule.subjectId } }
                : subject === "org"
                  ? { repo: { repoFullName: { startsWith: `${rule.subjectId}/` } } }
                  : { repo: { ownerId: input.ownerId } };

        const used = await usageSince(scope, rule.metric as LimitMetric, since(rule.period as LimitPeriod));
        if (used < rule.amount) continue;

        return {
            allowed: false,
            reason: describeRefusal({
                subject,
                subjectId: rule.subjectId,
                metric: rule.metric as LimitMetric,
                period: rule.period as LimitPeriod,
                amount: rule.amount,
                used
            })
        };
    }
    return { allowed: true };
}

/** What has been spent under this rule's scope in its window. */
async function usageSince(
    scope: Record<string, unknown>,
    metric: LimitMetric,
    from: Date
): Promise<number> {
    const where = { ...scope, createdAt: { gte: from } };
    if (metric === "runs") return await prisma.agentRun.count({ where });
    const totals = await prisma.agentRun.aggregate({ where, _sum: { tokensIn: true, tokensOut: true } });
    return (totals._sum.tokensIn ?? 0) + (totals._sum.tokensOut ?? 0);
}

/** Which roles and groups this person is in, for matching rules against. */
async function roleAndGroupIds(userId: string): Promise<{ roles: string[]; groups: string[] } | null> {
    const [roles, groups] = await Promise.all([
        prisma.userRole.findMany({ where: { userId }, select: { roleId: true } }),
        prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } })
    ]);
    return { roles: roles.map((row) => row.roleId), groups: groups.map((row) => row.groupId) };
}

/**
 * The refusal a person reads.
 *
 * It names the ceiling and what has been spent against it, because "you are over
 * a limit" with no numbers leaves somebody unable to tell a rule they should ask
 * to have raised from one they will be under again in an hour.
 */
function describeRefusal(input: {
    subject: LimitSubject;
    subjectId: string;
    metric: LimitMetric;
    period: LimitPeriod;
    amount: number;
    used: number;
}): string {
    const what = input.metric === "runs" ? "runs" : "tokens";
    const whose =
        input.subject === "repo"
            ? "This repository"
            : input.subject === "org"
              ? `Repositories under ${input.subjectId}`
              : "This account";
    return `${whose} has used ${input.used} of the ${input.amount} ${what} allowed in ${LIMIT_PERIOD_LABELS[input.period]}. An administrator sets these under Admin > Agents.`;
}
