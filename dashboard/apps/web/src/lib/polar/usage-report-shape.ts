/**
 * The shape of Polar's usage report and the periods it can span, apart from the
 * queries that fill it so the Usage page can import them: a client component
 * that reaches `usage-report.ts` pulls the database client into the browser
 * bundle and fails the production build.
 *
 * Client-safe.
 */

import type { Payer } from "@/lib/polar/shared";

export const POLAR_USAGE_RANGES = ["7d", "30d", "90d"] as const;
export type PolarUsageRange = (typeof POLAR_USAGE_RANGES)[number];

export interface PolarUsageTotals {
    answers: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    /** The priced answers' cost; `unpriced` counts the answers left out. */
    costUsd: number;
    unpriced: number;
}

export interface PolarUsageDay {
    /** The day's start, UTC, in milliseconds. */
    t: number;
    answers: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface PolarUsageModel extends PolarUsageTotals {
    provider: string;
    model: string;
    payer: Payer;
}

export interface PolarUsageChat {
    threadId: string;
    /** Null for a chat since deleted: what it spent still counts. */
    title: string | null;
    answers: number;
    tokens: number;
    costUsd: number;
}

/** How fast one model answered: p50 and p95 to the first token and to the end, in ms. */
export interface PolarModelLatency {
    provider: string;
    model: string;
    /** The answers that were timed; the rest predate timing or were not streamed. */
    timed: number;
    firstTokenP50: number | null;
    firstTokenP95: number | null;
    answerP50: number | null;
    answerP95: number | null;
}

export interface PolarUsageReport {
    range: PolarUsageRange;
    from: number;
    to: number;
    totals: PolarUsageTotals;
    days: PolarUsageDay[];
    models: PolarUsageModel[];
    chats: PolarUsageChat[];
    /** Per model, busiest first; only answers that were timed. */
    latency: PolarModelLatency[];
}
