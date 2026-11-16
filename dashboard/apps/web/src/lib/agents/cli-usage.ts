/**
 * What a Code session spent, for agents whose usage is not in a transcript
 * Polaris already reads: each CLI's own records are summed on its machine by
 * `USAGE_READER_JS` and the session's totals set from the answer.
 *
 * Read only where Polaris owns the session's home and it is this session's
 * alone (the session pool, not a shared home or an enrolled server): the
 * tools keep their records per home, not per conversation, so everything
 * found there is this session's.
 *
 * A cost the tool reported is taken as it is; anything else is priced from
 * the model catalogue the way `session-usage.ts` prices Claude's turns.
 * Totals only ever grow: a tool that prunes its old records does not take
 * back what was already counted.
 *
 * Ported from Agent Orchestrator (Apache-2.0), backend/internal/service/usage
 * (collector.go source roots) and backend/internal/pricing (catalogue prices).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { getCatalogModel } from "./model-catalog";
import { priceSlugs, turnCost, type ModelPrice } from "./session-usage";
import { USAGE_READER_CLIS, USAGE_READER_JS } from "./cli-usage-reader";

/** The shortest gap between two reads of one session's usage. */
export const USAGE_READ_DEBOUNCE_MS = 15_000;

/** What the machine may send back at most; the program prints far less. */
const OUTPUT_BYTES = 16_000;

/** Seconds the program may run before it is stopped, where `timeout` exists. */
const READ_SECONDS = 20;

/** The column limit of the session's token totals (a 32-bit integer). */
const TOKEN_CEILING = 2_000_000_000;

const tokens = z.number().int().nonnegative().max(1e12);

const rowSchema = z.object({
    p: z.string().max(64),
    m: z.string().min(1).max(128),
    f: z.union([z.literal(0), z.literal(1)]),
    i: tokens,
    o: tokens,
    cr: tokens,
    cw: tokens,
    c: z.number().nonnegative().max(1e6),
    n: z.number().int().nonnegative().max(1e9)
});

const answerSchema = z.object({ v: z.literal(1), rows: z.array(rowSchema).max(64) });

/** One provider and model's sums, as the machine reported them. */
export type UsageRow = z.infer<typeof rowSchema>;

/** Whether Polaris can read this CLI's usage. */
export function hasUsageReader(cli: string): boolean {
    return USAGE_READER_CLIS.has(cli);
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** The shell command that runs the reader for this CLI, or null for none. */
export function cliUsageCommand(cli: string): string | null {
    if (!hasUsageReader(cli)) return null;
    return [
        "if command -v node >/dev/null 2>&1; then",
        `T=""; if command -v timeout >/dev/null 2>&1; then T="timeout ${READ_SECONDS}"; fi;`,
        `$T node -e ${quote(USAGE_READER_JS)} ${quote(cli)} 2>/dev/null | head -c ${OUTPUT_BYTES};`,
        "fi"
    ].join(" ");
}

/** The machine's answer, or null when it is not one. Untrusted. Pure. */
export function parseUsageAnswer(output: string): UsageRow[] | null {
    const line = output.trim().split("\n").pop() ?? "";
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    const parsed = answerSchema.safeParse(raw);
    return parsed.success ? parsed.data.rows : null;
}

/** The catalogue slugs a CLI's provider and model may be filed under. Pure. */
export function cliPriceSlugs(provider: string, model: string): string[] {
    if (!model || model === "Tools/summaries" || model === "unknown") return [];
    const slugs: string[] = [];
    const push = (slug: string) => {
        if (!slugs.includes(slug)) slugs.push(slug);
    };
    // A model routed through a gateway often names its provider itself.
    if (model.includes("/")) push(model);
    if (provider === "anthropic") for (const slug of priceSlugs(model)) push(slug);
    else if (provider) push(`${provider}/${model}`);
    return slugs;
}

export interface UsageTotals {
    readonly tokensIn: number;
    readonly tokensOut: number;
    /** Null when nothing reported a cost and no model had a price. */
    readonly costUsd: number | null;
}

/** The session's totals from the rows, priced with `priceOf`. Pure but for it. */
export async function usageTotals(
    rows: readonly UsageRow[],
    priceOf: (provider: string, model: string) => Promise<ModelPrice | null>
): Promise<UsageTotals> {
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let priced = false;
    for (const row of rows) {
        tokensIn += row.i + row.cr + row.cw;
        tokensOut += row.o;
        if (row.f === 1) {
            cost += row.c;
            priced = true;
            continue;
        }
        const price = await priceOf(row.p, row.m);
        if (!price) continue;
        cost += turnCost(
            { messageId: "", model: row.m, input: row.i, output: row.o, cacheRead: row.cr, cacheWrite: row.cw, sidechain: false },
            price
        );
        priced = true;
    }
    return {
        tokensIn: Math.min(tokensIn, TOKEN_CEILING),
        tokensOut: Math.min(tokensOut, TOKEN_CEILING),
        costUsd: priced ? cost : null
    };
}

async function cataloguePrice(provider: string, model: string): Promise<ModelPrice | null> {
    for (const slug of cliPriceSlugs(provider, model)) {
        const found = await getCatalogModel(slug).catch(() => null);
        if (found && found.costInput !== null && found.costOutput !== null)
            return { input: found.costInput, output: found.costOutput };
    }
    return null;
}

/** Where a session runs, as far as reading its usage goes. */
interface SessionHome {
    readonly cli: string;
    readonly place: string;
    readonly sharedHome: boolean;
}

type Run = (sessionId: string, script: string) => Promise<{ code: number; output: string }>;

/**
 * Read the session's usage from its CLI's own records and set its totals.
 * Claimed on the row first, so pollers and hooks make one read every few
 * seconds; `final` (the read as the session ends) skips the wait.
 */
export async function readCliUsage(
    sessionId: string,
    run: Run,
    {
        final = false,
        now = new Date(),
        row: known
    }: {
        final?: boolean;
        now?: Date;
        /** The session as the caller already read it, to spare a query. */
        row?: SessionHome;
    } = {}
): Promise<"read" | "skipped" | "unavailable"> {
    const row =
        known ??
        (await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { cli: true, place: true, sharedHome: true }
        }));
    const command = row ? cliUsageCommand(row.cli) : null;
    if (!row || !command || row.place !== "local" || row.sharedHome) return "skipped";
    const claimed = await prisma.agentSession.updateMany({
        where: final
            ? { id: sessionId }
            : {
                  id: sessionId,
                  OR: [
                      { usageReadAt: null },
                      { usageReadAt: { lt: new Date(now.getTime() - USAGE_READ_DEBOUNCE_MS) } }
                  ]
              },
        data: { usageReadAt: now }
    });
    if (claimed.count === 0) return "skipped";

    const rows = parseUsageAnswer((await run(sessionId, command)).output);
    if (!rows) return "unavailable";
    if (rows.length === 0) return "read";
    const prices = new Map<string, Promise<ModelPrice | null>>();
    const totals = await usageTotals(rows, (provider, model) => {
        const key = `${provider}\n${model}`;
        if (!prices.has(key)) prices.set(key, cataloguePrice(provider, model));
        return prices.get(key)!;
    });
    // Never below what was counted: two writes are each a floor, so the order
    // two reads land in does not matter.
    await prisma.agentSession.updateMany({
        where: { id: sessionId, tokensIn: { lte: totals.tokensIn }, tokensOut: { lte: totals.tokensOut } },
        data: { tokensIn: totals.tokensIn, tokensOut: totals.tokensOut }
    });
    if (totals.costUsd !== null)
        await prisma.agentSession.updateMany({
            where: { id: sessionId, OR: [{ costUsd: null }, { costUsd: { lte: totals.costUsd } }] },
            data: { costUsd: totals.costUsd }
        });
    return "read";
}
