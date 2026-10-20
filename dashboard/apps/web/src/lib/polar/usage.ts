/**
 * What Polar spends, and whether it may spend more.
 *
 * Every answer records the provider's own token counts (the AI SDK's
 * `totalUsage`, summed over every step of the turn) in `PolarUsage`. The cost
 * is worked out from the model catalogue's prices, which `model-catalog.ts`
 * downloads from https://models.dev/api.json - an index that copies each
 * provider's published per-million-token prices (input and output, USD). A
 * model the index carries no price for gets no cost at all: tokens only, never
 * a guess. Cached-input and reasoning discounts are not modelled, so the cost
 * is an estimate and the screen says so.
 *
 * The ceilings are the administrator's existing agent usage rules
 * (`agent-usage-limits.ts`): a "tokens" rule on everyone, a person, a role or a
 * group also bounds what that person spends through Polar on the key this
 * Polaris shares. A person's own key is their own money and is never capped
 * here. Repository and GitHub-organisation rules are about agent runs and do
 * not apply to a chat.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { LanguageModelUsage } from "ai";
import type { Payer } from "@/lib/polar/shared";
import type { PolarModelOption } from "@/lib/polar/models";
import { since, appliesToPerson, roleAndGroupIds } from "@/lib/agents/agent-usage-limits";
import type { LimitPeriod, LimitSubject } from "@polaris/core";

/** What one answer spent, as its message metadata carries it. */
export interface AnswerUsage {
    inputTokens: number;
    outputTokens: number;
    /** Estimated from the catalogue's prices; null when it has none. */
    costUsd: number | null;
}

const PER_MILLION = 1_000_000;

/** The tokens and estimated cost of a turn on this model. */
export function answerUsage(
    usage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> | undefined,
    option: Pick<PolarModelOption, "costInput" | "costOutput">
): AnswerUsage {
    const inputTokens = Math.max(0, Math.round(usage?.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(usage?.outputTokens ?? 0));
    const { costInput, costOutput } = option;
    return {
        inputTokens,
        outputTokens,
        costUsd:
            typeof costInput === "number" && typeof costOutput === "number"
                ? (inputTokens * costInput + outputTokens * costOutput) / PER_MILLION
                : null
    };
}

export async function recordPolarUsage(input: {
    userId: string;
    threadId: string;
    messageId: string | null;
    provider: string;
    model: string;
    payer: Payer;
    usage: AnswerUsage;
}): Promise<void> {
    await prisma.polarUsage.create({
        data: {
            userId: input.userId,
            threadId: input.threadId,
            messageId: input.messageId,
            provider: input.provider,
            model: input.model,
            payer: input.payer,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            costUsd: input.usage.costUsd
        }
    });
}

/** The first moment of the current calendar month, in UTC. */
export function monthStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface UsageByModel {
    provider: string;
    model: string;
    payer: Payer;
    answers: number;
    inputTokens: number;
    outputTokens: number;
    /** The priced answers' cost; `unpriced` counts the answers left out. */
    costUsd: number;
    unpriced: number;
}

export interface MonthUsage {
    from: string;
    models: UsageByModel[];
}

/** This person's Polar spend since the month began, per model and payer. */
export async function polarMonthUsage(userId: string, now = new Date()): Promise<MonthUsage> {
    const from = monthStart(now);
    const where = { userId, createdAt: { gte: from } };
    const [rows, unpriced] = await Promise.all([
        prisma.polarUsage.groupBy({
            by: ["provider", "model", "payer"],
            where,
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costUsd: true }
        }),
        prisma.polarUsage.groupBy({
            by: ["provider", "model", "payer"],
            where: { ...where, costUsd: null },
            _count: { _all: true }
        })
    ]);
    const missing = new Map(
        unpriced.map((row) => [`${row.provider}\u0000${row.model}\u0000${row.payer}`, row._count._all])
    );
    const models = rows
        .map((row) => ({
            provider: row.provider,
            model: row.model,
            payer: row.payer as Payer,
            answers: row._count._all,
            inputTokens: row._sum.inputTokens ?? 0,
            outputTokens: row._sum.outputTokens ?? 0,
            costUsd: row._sum.costUsd ?? 0,
            unpriced: missing.get(`${row.provider}\u0000${row.model}\u0000${row.payer}`) ?? 0
        }))
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    return { from: from.toISOString(), models };
}

export interface SharedKeySpender {
    userId: string;
    name: string;
    answers: number;
    tokens: number;
    costUsd: number;
}

export interface SharedKeySpend {
    from: string;
    answers: number;
    tokens: number;
    costUsd: number;
    unpriced: number;
    people: SharedKeySpender[];
}

/** How many people the administrator's list names. */
const SPENDERS_SHOWN = 10;

/** What Polar spent on the key this Polaris shares since the month began:
 *  totals and the people who spent the most. For the administrator. */
export async function sharedKeySpend(now = new Date()): Promise<SharedKeySpend> {
    const from = monthStart(now);
    const where = { payer: "instance", createdAt: { gte: from } };
    const [totals, unpriced, people] = await Promise.all([
        prisma.polarUsage.aggregate({
            where,
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costUsd: true }
        }),
        prisma.polarUsage.count({ where: { ...where, costUsd: null } }),
        prisma.polarUsage.groupBy({
            by: ["userId"],
            where,
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costUsd: true },
            orderBy: { _sum: { outputTokens: "desc" } },
            take: SPENDERS_SHOWN
        })
    ]);
    const names = new Map(
        (
            await prisma.user.findMany({
                where: { id: { in: people.map((row) => row.userId) } },
                select: { id: true, name: true, email: true }
            })
        ).map((user) => [user.id, user.name || user.email])
    );
    return {
        from: from.toISOString(),
        answers: totals._count._all,
        tokens: (totals._sum.inputTokens ?? 0) + (totals._sum.outputTokens ?? 0),
        costUsd: totals._sum.costUsd ?? 0,
        unpriced,
        people: people.map((row) => ({
            userId: row.userId,
            name: names.get(row.userId) ?? row.userId,
            answers: row._count._all,
            tokens: (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0),
            costUsd: row._sum.costUsd ?? 0
        }))
    };
}

/** The subjects a chat answers to: the person and what they belong to. */
const CHAT_SUBJECTS: readonly LimitSubject[] = ["everyone", "user", "role", "group"];

/** A ceiling this person has reached, with the numbers the screen shows. */
export interface PolarLimitHit {
    used: number;
    amount: number;
    period: LimitPeriod;
}

/**
 * The first token ceiling this person has reached on the shared key, or null
 * when they may go on. Reads one table and stops when no rule is about tokens,
 * which is the common case. Windows roll, as the agent rules' do.
 */
export async function polarLimitReached(userId: string, now = Date.now()): Promise<PolarLimitHit | null> {
    const rules = await prisma.agentUsageLimit.findMany({
        where: { metric: "tokens", subjectType: { in: [...CHAT_SUBJECTS] } }
    });
    if (rules.length === 0) return null;
    const member = await roleAndGroupIds(userId);
    for (const rule of rules) {
        if (!appliesToPerson(rule, userId, member)) continue;
        const period = rule.period as LimitPeriod;
        const spent = await prisma.polarUsage.aggregate({
            where: {
                userId,
                payer: "instance",
                createdAt: { gte: since(period, now) }
            },
            _sum: { inputTokens: true, outputTokens: true }
        });
        const used = (spent._sum.inputTokens ?? 0) + (spent._sum.outputTokens ?? 0);
        if (used >= rule.amount) return { used, amount: rule.amount, period };
    }
    return null;
}
