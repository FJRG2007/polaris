/**
 * What a session spent, summed from the agent's own transcript as its history
 * is read.
 *
 * Claude Code writes every API response as one line per content block, each
 * carrying the same `message.id` and the response's `usage`. So a response is
 * counted once, from the last of its lines read, and the id last counted is
 * kept on the session so a response split across two reads is not counted
 * twice.
 *
 * The cost is an estimate: the catalogue's input and output prices per million
 * tokens, with cache writes at 1.25x and cache reads at 0.1x the input price,
 * which is how Anthropic prices prompt caching.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { getCatalogModel } from "./model-catalog";

/** One API response's usage, as the transcript reports it. */
export interface TurnUsage {
    readonly messageId: string;
    readonly model: string;
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    /** A sub-agent's turn: it runs in a conversation of its own, so it is
     *  spent like any other but says nothing about the main one's size. */
    readonly sidechain: boolean;
}

const count = z.number().int().nonnegative().max(100_000_000).catch(0).default(0);

const usageLineSchema = z.object({
    type: z.literal("assistant"),
    isSidechain: z.boolean().optional(),
    message: z.object({
        id: z.string().min(1).max(128),
        model: z.string().max(128).default(""),
        usage: z.object({
            input_tokens: count,
            output_tokens: count,
            cache_read_input_tokens: count,
            cache_creation_input_tokens: count
        })
    })
});

/** The usage a Claude Code transcript line reports, or null for none. Pure. */
export function claudeLineUsage(line: string): TurnUsage | null {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    const parsed = usageLineSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { message } = parsed.data;
    // Claude Code's own placeholder for a turn no API call made.
    if (message.model === "<synthetic>") return null;
    return {
        messageId: message.id,
        model: message.model,
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens,
        cacheWrite: message.usage.cache_creation_input_tokens,
        sidechain: parsed.data.isSidechain === true
    };
}

/** The main conversation's size after the last of these turns, or null when
 *  none of them is the main conversation's. Pure. */
export function contextAfter(
    lines: readonly TurnUsage[]
): { tokens: number; model: string } | null {
    for (let index = lines.length - 1; index >= 0; index--) {
        const turn = lines[index]!;
        if (turn.sidechain) continue;
        return {
            tokens: turn.input + turn.cacheRead + turn.cacheWrite + turn.output,
            model: turn.model
        };
    }
    return null;
}

/**
 * The responses to count from lines read in order: one per message id, its
 * last line's usage, leaving out the one already counted. Pure.
 */
export function foldTurns(
    lines: readonly TurnUsage[],
    lastCounted: string | null
): { turns: TurnUsage[]; last: string | null } {
    const byId = new Map<string, TurnUsage>();
    let last = lastCounted;
    for (const line of lines) {
        byId.delete(line.messageId);
        byId.set(line.messageId, line);
        last = line.messageId;
    }
    if (lastCounted !== null) byId.delete(lastCounted);
    return { turns: [...byId.values()], last };
}

/** Prices in USD per million tokens. */
export interface ModelPrice {
    readonly input: number;
    readonly output: number;
}

/** One response's estimated cost in USD. Pure. */
export function turnCost(turn: TurnUsage, price: ModelPrice): number {
    const input = turn.input + turn.cacheWrite * 1.25 + turn.cacheRead * 0.1;
    return (input * price.input + turn.output * price.output) / 1_000_000;
}

/** The catalogue slugs a transcript's model name may be filed under. Pure. */
export function priceSlugs(model: string): string[] {
    if (!model) return [];
    const undated = model.replace(/-\d{8}$/, "");
    const names = undated === model ? [model] : [model, undated];
    return names.map((name) => `anthropic/${name}`);
}

async function priceOf(model: string): Promise<ModelPrice | null> {
    for (const slug of priceSlugs(model)) {
        const found = await getCatalogModel(slug).catch(() => null);
        if (found && found.costInput !== null && found.costOutput !== null)
            return { input: found.costInput, output: found.costOutput };
    }
    return null;
}

/**
 * Add what these transcript lines report to the session's totals.
 *
 * Written only where the id last counted is still the one read, like the
 * transcript cursor: a read that lost a race to another adds nothing.
 */
export async function recordSessionUsage(
    sessionId: string,
    lines: readonly TurnUsage[]
): Promise<void> {
    if (lines.length === 0) return;
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { usageMessageId: true, costUsd: true }
    });
    if (!row) return;
    const { turns, last } = foldTurns(lines, row.usageMessageId);
    if (turns.length === 0 && last === row.usageMessageId) return;
    const context = contextAfter(lines);

    const prices = new Map<string, ModelPrice | null>();
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let priced = false;
    for (const turn of turns) {
        tokensIn += turn.input + turn.cacheRead + turn.cacheWrite;
        tokensOut += turn.output;
        if (!prices.has(turn.model)) prices.set(turn.model, await priceOf(turn.model));
        const price = prices.get(turn.model);
        if (price) {
            cost += turnCost(turn, price);
            priced = true;
        }
    }
    await prisma.agentSession.updateMany({
        where: { id: sessionId, usageMessageId: row.usageMessageId },
        data: {
            tokensIn: { increment: tokensIn },
            tokensOut: { increment: tokensOut },
            usageMessageId: last,
            ...(context ? { contextTokens: context.tokens, contextModel: context.model } : {}),
            ...(priced ? { costUsd: (row.costUsd ?? 0) + cost } : {})
        }
    });
}
