/**
 * What a server has cost, from the price its provider published.
 *
 * Providers that publish both an hourly and a monthly price bill the hours a
 * server existed in a calendar month and stop at the monthly price; that is the
 * rule applied here, month by month in UTC. With only an hourly price the hours
 * are multiplied out with no cap; with only a monthly one, the share of the month
 * the server existed. With neither there is no figure at all, never a guess.
 *
 * Pure.
 */

export interface Price {
    readonly hourly: number | null;
    readonly monthly: number | null;
    readonly currency: string | null;
}

const HOUR_MS = 3_600_000;

function monthStart(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

function nextMonth(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** What the time between `from` and `to`, inside one month, cost. */
function costWithinMonth(price: Price, from: Date, to: Date): number {
    const hours = Math.max(0, to.getTime() - from.getTime()) / HOUR_MS;
    if (price.hourly !== null) {
        const billed = Math.ceil(hours - 1e-9) * price.hourly;
        return price.monthly !== null ? Math.min(billed, price.monthly) : billed;
    }
    if (price.monthly !== null) {
        const monthHours = (nextMonth(from).getTime() - monthStart(from).getTime()) / HOUR_MS;
        return (price.monthly * hours) / monthHours;
    }
    return 0;
}

/** The cost between two instants, month by month. Null without a price. */
export function costBetween(price: Price, from: Date, to: Date): number | null {
    if (price.hourly === null && price.monthly === null) return null;
    let total = 0;
    let cursor = from;
    while (cursor < to) {
        const end = nextMonth(cursor) < to ? nextMonth(cursor) : to;
        total += costWithinMonth(price, cursor, end);
        cursor = end;
    }
    return round(total);
}

/** One server's figures for the cost panel. */
export function serverCosts(
    price: Price,
    createdAt: Date,
    destroyedAt: Date | null,
    now: Date
): { sinceCreation: number | null; thisMonth: number | null } {
    const end = destroyedAt && destroyedAt < now ? destroyedAt : now;
    const start = monthStart(now);
    return {
        sinceCreation: costBetween(price, createdAt, end),
        // A server gone before this month began cost nothing in it (or has no
        // figure, without a price): an empty interval answers exactly that.
        thisMonth: costBetween(
            price,
            createdAt > start ? createdAt : start,
            end > start ? end : start
        )
    };
}

/** Totals by currency; servers with no price are counted apart. */
export function totalsByCurrency(
    rows: readonly { readonly currency: string | null; readonly amount: number | null }[]
): { totals: Readonly<Record<string, number>>; unpriced: number } {
    const totals: Record<string, number> = {};
    let unpriced = 0;
    for (const row of rows) {
        if (row.amount === null || !row.currency) {
            unpriced++;
            continue;
        }
        totals[row.currency] = round((totals[row.currency] ?? 0) + row.amount);
    }
    return { totals, unpriced };
}

function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}
