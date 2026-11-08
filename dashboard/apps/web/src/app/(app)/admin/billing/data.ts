"use server";

import { requireAdmin } from "@/lib/session";
import { getBillingRates } from "@/lib/billing/rates";

/** The rates the statement is priced at. Wrapped, so "no rates set" is not "gone". */
export async function loadBillingRatesAction() {
    await requireAdmin();
    return { rates: await getBillingRates() };
}
