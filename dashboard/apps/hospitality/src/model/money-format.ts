/**
 * Money, rates and plain numbers written the way the reader's Polaris display
 * preferences say (their language's separators, their clock and date order),
 * while an amount keeps its own currency: a venue in yen shows no decimals and
 * one in euros shows two, whatever the reader's preferred currency is.
 *
 * Amounts are integers in hundredths of the currency's unit, as stored.
 *
 * Pure: it takes the host's `DisplayFormat` (or anything with its `number`).
 */

export interface NumberFormatter {
    number(value: number | null | undefined, options?: Intl.NumberFormatOptions): string;
}

/** 1250 -> "12,50 EUR" / "EUR 12.50", in the currency's own minor units. */
export function formatMoney(format: NumberFormatter, cents: number, currency: string): string {
    return format.number(cents / 100, { style: "currency", currency });
}

/** A rate in basis points: 1000 -> "10 %" / "10%"; 550 -> "5,5 %". */
export function formatRate(format: NumberFormatter, basisPoints: number): string {
    return format.number(basisPoints / 10_000, { style: "percent", maximumFractionDigits: 2 });
}

/** An amount as a person types it back into a field: 1250 -> "12,50" or "12.50", no grouping. */
export function typedAmount(format: NumberFormatter, cents: number): string {
    return format.number(cents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}
