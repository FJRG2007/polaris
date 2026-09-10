/**
 * Turning what the metrics collector measured into a monthly statement.
 *
 * Pure: the web side reads the hourly figures and hands them in, one hour of one
 * subject at a time, and everything that decides what an hour is worth - how much
 * of it the service was running, how many cores a share of the machine is, what
 * a GB-month is - happens here, where a test can pin it.
 *
 * Four things are measured, each from a figure the collector already keeps:
 *
 *   - CPU, in vCPU-hours. The collector records a service's CPU as a share of the
 *     whole machine, so a share becomes cores through the machine's own core
 *     count. A machine whose count is not known yet leaves that hour's CPU
 *     unmeasured rather than guessed, and the statement says so.
 *   - Memory, in GB-hours: what the service held, for as long as it ran.
 *   - Storage, in GB-months: what its volumes held, spread over the month the
 *     way every provider prices a disk.
 *   - Network out, in GB: what the service sent, from the counters it reports.
 *
 * A GB here is 1024^3 bytes, which is what every other byte figure in Polaris
 * already means.
 *
 * Money is only ever the product of those and a price somebody set. With no
 * prices a statement is usage alone; with some, only the ones set are charged.
 */

import type { CurrencyCode } from "./schemas/display.js";
import { BILLING_RATE_KEYS, type BillingRates } from "./schemas/billing.js";

const HOUR_MS = 3_600_000;
const GB = 1024 ** 3;

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
] as const;

/** The month an instant falls in, "2026-09", on UTC. */
export function billingMonthOf(at: Date): string {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The instants a month runs between: its first millisecond, and the first of the
 *  next month. Null for anything that is not a "YYYY-MM" month. */
export function billingMonthRange(month: string): { from: Date; to: Date } | null {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) return null;
    const year = Number(match[1]);
    const index = Number(match[2]) - 1;
    return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)) };
}

/** "September 2026". Written from a table rather than the runtime's locale, so a
 *  statement drawn on the server reads the same as one drawn in the browser. */
export function billingMonthLabel(month: string): string {
    const range = billingMonthRange(month);
    if (!range) return month;
    return `${MONTH_NAMES[range.from.getUTCMonth()]} ${range.from.getUTCFullYear()}`;
}

/** How many hours a month has, which is what a GB-hour is divided by to become a
 *  GB-month. */
export function hoursInMonth(month: string): number {
    const range = billingMonthRange(month);
    return range ? (range.to.getTime() - range.from.getTime()) / HOUR_MS : 0;
}

/**
 * The months a statement can be read for, newest first: this one, and every one
 * before it that still has hourly figures kept.
 *
 * A month that ended before the oldest figure was kept has nothing left to add
 * up, and offering it would be offering a statement of zeros.
 */
export function billingMonthsOffered(now: Date, retentionMs: number): string[] {
    const oldest = now.getTime() - retentionMs;
    const months: string[] = [];
    let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (;;) {
        const month = billingMonthOf(cursor);
        const range = billingMonthRange(month);
        if (!range || range.to.getTime() <= oldest) break;
        months.push(month);
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
    }
    return months;
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/** One subject's figures for one UTC hour, as the collector kept them. */
export interface UsageHour {
    /** `app` is a deployed service, `volume` a volume attached to one. */
    readonly subjectType: "app" | "volume";
    readonly subjectId: string;
    readonly cpuPercentAvg: number | null;
    readonly memUsedBytesAvg: number | null;
    readonly diskUsedBytesAvg: number | null;
    /** Bytes the service sent during the hour. */
    readonly netTxBytesSum: number | null;
    /** How many readings the hour was made from. */
    readonly samples: number;
}

/** What something used over a period. */
export interface BillingUsage {
    readonly cpuHours: number;
    readonly memoryGbHours: number;
    readonly storageGbHours: number;
    readonly egressGb: number;
    /** Hours with CPU readings on a machine whose core count is not known, so their
     *  CPU is not in `cpuHours`. */
    readonly cpuUnmeasuredHours: number;
}

export const EMPTY_USAGE: BillingUsage = {
    cpuHours: 0,
    memoryGbHours: 0,
    storageGbHours: 0,
    egressGb: 0,
    cpuUnmeasuredHours: 0
};

/** Two periods' usage, together. */
export function addUsage(left: BillingUsage, right: BillingUsage): BillingUsage {
    return {
        cpuHours: left.cpuHours + right.cpuHours,
        memoryGbHours: left.memoryGbHours + right.memoryGbHours,
        storageGbHours: left.storageGbHours + right.storageGbHours,
        egressGb: left.egressGb + right.egressGb,
        cpuUnmeasuredHours: left.cpuUnmeasuredHours + right.cpuUnmeasuredHours
    };
}

/** How the collector samples, which is what turns a count of readings into time. */
export interface MeterCadence {
    /** Minutes between two readings of a service. */
    readonly appSampleMinutes: number;
    /** Minutes between two readings of a volume, which is measured less often. */
    readonly volumeSampleMinutes: number;
}

function finite(value: number | null): number | null {
    return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * What one hour of one subject is worth.
 *
 * How much of the hour it ran is read from how many readings the hour holds: a
 * service that is not running is not sampled, so twenty readings a minute apart
 * is twenty minutes of use, not an hour of it. Clamped to the hour, because a
 * catch-up pass can fold a reading or two more than the cadence would suggest.
 *
 * `cores` is the machine the service ran on, or null when it is not known - in
 * which case the CPU is counted as unmeasured instead of priced at a guess.
 */
export function meterHour(
    hour: UsageHour,
    cores: number | null,
    cadence: MeterCadence
): BillingUsage {
    const minutes =
        hour.subjectType === "app" ? cadence.appSampleMinutes : cadence.volumeSampleMinutes;
    const covered = Math.min(1, Math.max(0, (hour.samples * minutes) / 60));
    if (hour.subjectType === "volume") {
        const disk = finite(hour.diskUsedBytesAvg);
        return { ...EMPTY_USAGE, storageGbHours: disk === null ? 0 : (disk / GB) * covered };
    }

    const cpu = finite(hour.cpuPercentAvg);
    const memory = finite(hour.memUsedBytesAvg);
    const sent = finite(hour.netTxBytesSum);
    const knownCores = cores !== null && Number.isFinite(cores) && cores > 0 ? cores : null;
    return {
        cpuHours: cpu !== null && knownCores !== null ? (cpu / 100) * knownCores * covered : 0,
        memoryGbHours: memory === null ? 0 : (memory / GB) * covered,
        storageGbHours: 0,
        egressGb: sent === null ? 0 : sent / GB,
        cpuUnmeasuredHours: cpu !== null && cpu > 0 && knownCores === null ? covered : 0
    };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** What something cost, per thing measured. A part is null when it has no price. */
export interface BillingCost {
    readonly cpu: number | null;
    readonly memory: number | null;
    readonly storage: number | null;
    readonly egress: number | null;
    /** The priced parts, added up. */
    readonly total: number;
}

/**
 * How many digits after the point a currency is written with - two for most,
 * none for the yen or the Chilean peso. Asked of the runtime's own tables rather
 * than kept as a second list that could disagree with how the amount is drawn.
 */
export function currencyDigits(currency: CurrencyCode): number {
    try {
        const format = new Intl.NumberFormat("en", { style: "currency", currency });
        return format.resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
        return 2;
    }
}

/** An amount rounded to what the currency can be paid in, half away from zero. */
export function roundMoney(amount: number, currency: CurrencyCode): number {
    const scale = 10 ** currencyDigits(currency);
    return Math.round((amount + Number.EPSILON) * scale) / scale;
}

/**
 * Usage over one month, priced.
 *
 * Each part is rounded to the currency on its own and the total is the sum of
 * the rounded parts, so a statement adds up exactly as it is read - a line whose
 * parts say 1.00 and 2.00 never totals 3.01.
 */
export function priceUsage(usage: BillingUsage, rates: BillingRates, month: string): BillingCost {
    const hours = hoursInMonth(month) || 1;
    const quantity: Record<(typeof BILLING_RATE_KEYS)[number], number> = {
        cpuHour: usage.cpuHours,
        memoryGbHour: usage.memoryGbHours,
        storageGbMonth: usage.storageGbHours / hours,
        egressGb: usage.egressGb
    };
    const part = (key: (typeof BILLING_RATE_KEYS)[number]): number | null => {
        const rate = rates[key];
        return rate === null ? null : roundMoney(quantity[key] * rate, rates.currency);
    };
    const cpu = part("cpuHour");
    const memory = part("memoryGbHour");
    const storage = part("storageGbMonth");
    const egress = part("egressGb");
    const total = [cpu, memory, storage, egress].reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0
    );
    return { cpu, memory, storage, egress, total: roundMoney(total, rates.currency) };
}

/** Two costs, together. Lines of one statement share their prices, so a part that
 *  is unpriced on one is unpriced on all of them. */
export function addCost(
    left: BillingCost,
    right: BillingCost,
    currency: CurrencyCode
): BillingCost {
    const sum = (a: number | null, b: number | null): number | null =>
        a === null && b === null ? null : roundMoney((a ?? 0) + (b ?? 0), currency);
    return {
        cpu: sum(left.cpu, right.cpu),
        memory: sum(left.memory, right.memory),
        storage: sum(left.storage, right.storage),
        egress: sum(left.egress, right.egress),
        total: roundMoney(left.total + right.total, currency)
    };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** Who a project belongs to: an organization, or a person's own shelf. */
export interface BillingOwner {
    readonly kind: "org" | "user";
    readonly id: string;
    readonly name: string;
    /** The organization's handle or the person's username, which is what a link
     *  to them is built from. Null for an account that has none. */
    readonly handle: string | null;
}

/** One project's month. */
export interface StatementLine {
    readonly projectId: string;
    readonly projectName: string;
    readonly owner: BillingOwner;
    readonly usage: BillingUsage;
    readonly cost: BillingCost | null;
}

/** One owner's projects, added up. */
export interface StatementOwnerTotal {
    readonly owner: BillingOwner;
    readonly projects: number;
    readonly usage: BillingUsage;
    readonly cost: BillingCost | null;
}

export interface Statement {
    readonly month: string;
    /** The prices it was worked out at, or null when none are set. */
    readonly rates: BillingRates | null;
    readonly lines: readonly StatementLine[];
    readonly owners: readonly StatementOwnerTotal[];
    readonly usage: BillingUsage;
    readonly cost: BillingCost | null;
}

/** A project and whatever its services used this month, before it is priced. */
export interface MeteredProject {
    readonly projectId: string;
    readonly projectName: string;
    readonly owner: BillingOwner;
    readonly usage: BillingUsage;
}

function ownerKey(owner: BillingOwner): string {
    return `${owner.kind}:${owner.id}`;
}

/**
 * The statement for a month: a line per project, heaviest first, a total per
 * owner, and one for everything.
 *
 * The totals are sums of the lines as priced, not a second pricing of the summed
 * usage, so the owner total on screen is always what its lines add up to.
 */
export function buildStatement(
    month: string,
    projects: readonly MeteredProject[],
    rates: BillingRates | null
): Statement {
    const lines: StatementLine[] = projects.map((project) => ({
        ...project,
        cost: rates ? priceUsage(project.usage, rates, month) : null
    }));
    lines.sort(
        (left, right) =>
            (right.cost?.total ?? 0) - (left.cost?.total ?? 0) ||
            weight(right.usage) - weight(left.usage) ||
            left.projectName.localeCompare(right.projectName)
    );

    const owners = new Map<string, StatementOwnerTotal>();
    let usage = EMPTY_USAGE;
    let cost: BillingCost | null = null;
    for (const line of lines) {
        usage = addUsage(usage, line.usage);
        if (rates && line.cost) cost = cost ? addCost(cost, line.cost, rates.currency) : line.cost;
        const key = ownerKey(line.owner);
        const held = owners.get(key);
        owners.set(key, {
            owner: line.owner,
            projects: (held?.projects ?? 0) + 1,
            usage: addUsage(held?.usage ?? EMPTY_USAGE, line.usage),
            cost:
                rates && line.cost
                    ? held?.cost
                        ? addCost(held.cost, line.cost, rates.currency)
                        : line.cost
                    : null
        });
    }

    const emptyCost: BillingCost | null = rates ? priceUsage(EMPTY_USAGE, rates, month) : null;
    return {
        month,
        rates,
        lines,
        owners: [...owners.values()].sort(
            (left, right) =>
                (right.cost?.total ?? 0) - (left.cost?.total ?? 0) ||
                left.owner.name.localeCompare(right.owner.name)
        ),
        usage,
        cost: cost ?? emptyCost
    };
}

/** A rough size, for ordering lines when there is no money to order them by. */
function weight(usage: BillingUsage): number {
    return usage.cpuHours + usage.memoryGbHours + usage.storageGbHours + usage.egressGb;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** The shares of a budget that are announced, lowest first. */
export const BUDGET_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

/** The highest threshold a month's spend has reached, or 0 below the first. */
export function budgetLevel(spent: number, budget: number): 0 | BudgetThreshold {
    if (!(budget > 0) || !Number.isFinite(spent)) return 0;
    const share = (spent / budget) * 100;
    let reached: 0 | BudgetThreshold = 0;
    for (const threshold of BUDGET_THRESHOLDS) if (share >= threshold) reached = threshold;
    return reached;
}

/**
 * The threshold to announce now, or null when there is nothing new to say.
 *
 * Each threshold is announced once a month. A spend that jumps straight past both
 * is told the higher one alone - "you have gone over" already says it passed
 * eighty - and a new month starts with nothing announced.
 */
export function budgetAlertDue(input: {
    readonly spent: number;
    readonly budget: number;
    readonly month: string;
    readonly alertedMonth: string | null;
    readonly alertedLevel: number;
}): BudgetThreshold | null {
    const level = budgetLevel(input.spent, input.budget);
    if (level === 0) return null;
    const already = input.alertedMonth === input.month ? input.alertedLevel : 0;
    return level > already ? level : null;
}
