/**
 * The instance's prices, as a platform setting.
 *
 * One row for the whole card, because the prices only mean anything together:
 * they share a currency, and a statement priced with half of an old card and
 * half of a new one is a statement nobody can explain. Unset is the default and
 * a real state - every screen shows usage without money until an administrator
 * writes one.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import { storedBillingRates, type BillingRates } from "@polaris/core";

const RATES_KEY = "billing.rates";

/** The prices, or null when none are set. */
export async function getBillingRates(): Promise<BillingRates | null> {
    return storedBillingRates(await getSetting(RATES_KEY));
}

/** Store the prices, or forget them with null. */
export async function setBillingRates(rates: BillingRates | null): Promise<void> {
    await setSetting(RATES_KEY, rates === null ? null : JSON.stringify(rates));
}
