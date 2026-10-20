/**
 * How Polar's spend reads on screen: token counts in the reader's own digits,
 * and an estimated cost in US dollars - the currency the catalogue's prices are
 * published in - with enough places that a fraction of a cent is not shown as
 * nothing.
 *
 * Client-safe.
 */

export function formatTokens(count: number, locale: string): string {
    return new Intl.NumberFormat(locale, {
        notation: count >= 100_000 ? "compact" : "standard"
    }).format(count);
}

export function formatUsd(amount: number, locale: string): string {
    const places = amount === 0 || amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4;
    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: places,
        maximumFractionDigits: places
    }).format(amount);
}
