/**
 * How many lookups each reputation provider may be sent from this process,
 * whoever is asking.
 *
 * One budget per provider rather than one per feature: chat's link check and the
 * mail filter ask VirusTotal with the same key, and the free tier's limit is the
 * key's, so two budgets that each fit it together would not. Past the budget a
 * lookup is not sent at all - the caller treats that as no opinion, which is what
 * the provider's own refusal would have come to anyway.
 *
 * VirusTotal's figures are its free Public API's: four a minute and 500 a day.
 * A paid key allows more but is held to them all the same. Dymo's quota depends on
 * the plan and is not something Polaris can read, so its ceiling here is
 * Polaris's own guard against one busy channel spending the month's quota in an
 * afternoon, not the provider's limit.
 */

export const BUDGETED_PROVIDERS = [
    "virustotal",
    "dymo",
    "criminalip",
    "deepl",
    "google-translate"
] as const;
export type BudgetedProvider = (typeof BUDGETED_PROVIDERS)[number];

export const LOOKUP_BUDGET: Readonly<
    Record<BudgetedProvider, { perMinute: number; perDay: number; charsPerDay?: number }>
> = {
    virustotal: { perMinute: 4, perDay: 500 },
    dymo: { perMinute: 30, perDay: 2000 },
    criminalip: { perMinute: 30, perDay: 2000 },
    // Translation is asked by people typing, a request per pause, so the day
    // allows far more of them. Billed per character by the provider, so the day
    // also holds a ceiling on characters sent; both are Polaris's own guard
    // against a loop or one busy reader, not the account's quota.
    deepl: { perMinute: 120, perDay: 10000, charsPerDay: 1_000_000 },
    "google-translate": { perMinute: 120, perDay: 10000, charsPerDay: 1_000_000 }
};

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** When each lookup in the last day was sent, per provider. In memory: one
 *  process is one deployment's dashboard, and a restart forgetting a day's count
 *  costs at most one day's budget again. */
const spent = new Map<BudgetedProvider, number[]>();

/**
 * Take one lookup from the provider's budget, or answer false when there is
 * none left in this minute or this day.
 *
 * `share` is the part of each window this caller may use, so a caller that can
 * wait (chat, checking after the send) leaves the rest to one that cannot (mail,
 * deciding where a message lands). It never rounds down to nothing.
 */
export function takeLookup(provider: BudgetedProvider, share = 1, now = Date.now()): boolean {
    const times = (spent.get(provider) ?? []).filter((at) => now - at < DAY_MS);
    const lastMinute = times.filter((at) => now - at < MINUTE_MS).length;
    const limit = LOOKUP_BUDGET[provider];
    const perDay = Math.max(1, Math.floor(limit.perDay * share));
    const perMinute = Math.max(1, Math.floor(limit.perMinute * share));
    if (times.length >= perDay || lastMinute >= perMinute) {
        spent.set(provider, times);
        return false;
    }
    times.push(now);
    spent.set(provider, times);
    return true;
}

/** Forget what was spent. For the tests. */
export function resetLookupBudget(): void {
    spent.clear();
}
