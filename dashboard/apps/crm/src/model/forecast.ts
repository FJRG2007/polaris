/**
 * The sales forecast: the opportunities expected to close in each coming
 * period, what is already won there, what is still open, and what the open
 * deals are worth once each is weighed by how likely its stage is to win.
 *
 * "Expected" is the won amount plus every open amount times its stage's odds.
 * The last stage is the won one and always counts in full. Amounts are kept per
 * currency and never added across currencies.
 *
 * Pure and client-safe: the server feeds it grouped rows, the screen reads it.
 */

import { z } from "zod";
import { bucketOf, nextBucket } from "./dashboards";
import { OPPORTUNITY_STAGES, type OpportunityStage } from "./objects";

/** The stage a deal is won at. */
export const WON_STAGE: OpportunityStage = "customer";

/** The stages still in play, first to last. */
export const OPEN_STAGES = OPPORTUNITY_STAGES.filter((stage) => stage !== WON_STAGE);

export type OpenStage = Exclude<OpportunityStage, typeof WON_STAGE>;

export type Odds = Readonly<Record<OpenStage, number>>;

/** Odds a shelf starts with: a deal further along is likelier to close. */
export const DEFAULT_ODDS: Odds = { new: 10, screening: 20, meeting: 40, proposal: 60 };

export const FORECAST_GRANULARITIES = ["month", "quarter"] as const;
export type ForecastGranularity = (typeof FORECAST_GRANULARITIES)[number];

export const MAX_PERIODS = 12;

const percent = z.number().int().min(0).max(100);

/** Odds as a request sends them: every open stage, a whole percent each. */
export const oddsSchema = z
    .object(
        Object.fromEntries(OPEN_STAGES.map((stage) => [stage, percent])) as Record<
            OpenStage,
            typeof percent
        >
    )
    .strict();

export const forecastInputSchema = z
    .object({
        granularity: z.enum(FORECAST_GRANULARITIES),
        periods: z.number().int().min(1).max(MAX_PERIODS),
        mine: z.boolean()
    })
    .strict();

export type ForecastInput = z.infer<typeof forecastInputSchema>;

/** Stored odds, each stage that is missing or unreadable taking its default. */
export function readOdds(raw: unknown): Odds {
    const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const odds = { ...DEFAULT_ODDS };
    for (const stage of OPEN_STAGES) {
        const parsed = percent.safeParse(stored[stage]);
        if (parsed.success) odds[stage] = parsed.data;
    }
    return odds;
}

/** One currency's amounts in a period. */
export interface Amounts {
    /** Won there: deals at the last stage. */
    won: number;
    /** Still open there, at full value. */
    open: number;
    /** Won plus open weighed by its stage's odds. */
    expected: number;
}

export interface ForecastPeriod {
    /** First day of the period, `YYYY-MM-DD`; or "pastDue" / "undated" for the
     *  open deals whose close date has passed or was never set. */
    readonly key: string;
    deals: number;
    wonDeals: number;
    /** Per currency code. Deals with no amount count as deals only. */
    money: Record<string, Amounts>;
}

export interface Forecast {
    readonly granularity: ForecastGranularity;
    readonly periods: ForecastPeriod[];
    readonly pastDue: ForecastPeriod;
    readonly undated: ForecastPeriod;
    /** Every currency any amount is in, the most used first. */
    readonly currencies: string[];
    readonly odds: Odds;
    /** Some rows were left uncounted: far more than a forecast reads. */
    readonly capped: boolean;
}

/** One group the database counted: deals sharing a day, stage and currency. */
export interface ForecastRow {
    readonly closeDate: Date | null;
    readonly stage: string;
    readonly currency: string;
    readonly deals: number;
    /** Their amounts added up; null when none had one. */
    readonly amount: number | null;
}

/** The first day of each period the forecast covers, and the day after the last. */
export function forecastRange(
    now: Date,
    granularity: ForecastGranularity,
    periods: number
): { starts: string[]; end: string } {
    const starts = [bucketOf(now, granularity)];
    while (starts.length < periods) {
        starts.push(nextBucket(starts[starts.length - 1]!, granularity));
    }
    return { starts, end: nextBucket(starts[starts.length - 1]!, granularity) };
}

function emptyPeriod(key: string): ForecastPeriod {
    return { key, deals: 0, wonDeals: 0, money: {} };
}

const cents = (value: number) => Math.round(value * 100) / 100;

function addRow(period: ForecastPeriod, row: ForecastRow, odds: Odds): void {
    const won = row.stage === WON_STAGE;
    period.deals += row.deals;
    if (won) period.wonDeals += row.deals;
    if (row.amount === null || row.currency === "") return;
    const into = (period.money[row.currency] ??= { won: 0, open: 0, expected: 0 });
    if (won) {
        into.won = cents(into.won + row.amount);
        into.expected = cents(into.expected + row.amount);
        return;
    }
    const chance = (odds as Record<string, number>)[row.stage] ?? 0;
    into.open = cents(into.open + row.amount);
    into.expected = cents(into.expected + (row.amount * chance) / 100);
}

/**
 * The forecast from grouped rows. Rows inside the range land in their period;
 * open rows before it are past due and open rows with no date are undated.
 * A won row outside the range belongs to no period and is left out.
 */
export function buildForecast(
    rows: readonly ForecastRow[],
    odds: Odds,
    range: { starts: string[]; end: string },
    granularity: ForecastGranularity,
    capped = false
): Forecast {
    const periods = range.starts.map(emptyPeriod);
    const byKey = new Map(periods.map((period) => [period.key, period]));
    const pastDue = emptyPeriod("pastDue");
    const undated = emptyPeriod("undated");
    const used = new Map<string, number>();
    const first = range.starts[0]!;
    for (const row of rows) {
        const open = row.stage !== WON_STAGE;
        let period: ForecastPeriod | undefined;
        if (row.closeDate === null) {
            period = open ? undated : undefined;
        } else {
            const day = row.closeDate.toISOString().slice(0, 10);
            if (day < first) period = open ? pastDue : undefined;
            else if (day < range.end) period = byKey.get(bucketOf(row.closeDate, granularity));
        }
        if (!period) continue;
        addRow(period, row, odds);
        if (row.amount !== null && row.currency !== "") {
            used.set(row.currency, (used.get(row.currency) ?? 0) + row.deals);
        }
    }
    const currencies = [...used.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code]) => code);
    return { granularity, periods, pastDue, undated, currencies, odds, capped };
}

/** The sum of a currency's amounts over some periods. */
export function totalOf(periods: readonly ForecastPeriod[], currency: string): Amounts {
    const total: Amounts = { won: 0, open: 0, expected: 0 };
    for (const period of periods) {
        const amounts = period.money[currency];
        if (!amounts) continue;
        total.won = cents(total.won + amounts.won);
        total.open = cents(total.open + amounts.open);
        total.expected = cents(total.expected + amounts.expected);
    }
    return total;
}
