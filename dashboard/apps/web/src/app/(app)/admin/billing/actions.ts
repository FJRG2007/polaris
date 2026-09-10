"use server";

/**
 * Setting the instance's prices, and taking them away.
 *
 * Administrator-only and audited: a price decides what every organization on the
 * instance is told it owes, which is exactly the setting somebody should be able
 * to see was changed, and by whom.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getBillingRates, setBillingRates } from "@/lib/billing/rates";
import { billingRatesInputSchema, type BillingRates } from "@polaris/core";

export async function saveBillingRatesAction(input: unknown): Promise<{ rates?: BillingRates; error?: string }> {
    const admin = await requireAdmin();
    const parsed = billingRatesInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the prices and try again" };

    try {
        const before = await getBillingRates();
        await setBillingRates(parsed.data);
        await recordAudit({
            actorId: admin.id,
            action: "billing.rates",
            targetType: "instance",
            metadata: { ...parsed.data, ...(before ? { previousCurrency: before.currency } : {}) }
        });
        revalidatePath("/admin/billing");
        return { rates: parsed.data };
    } catch (caught) {
        console.error("polaris: the prices could not be saved:", caught);
        return { error: "The prices could not be saved. Try again." };
    }
}

/** Take the prices away: every statement goes back to usage without money. */
export async function clearBillingRatesAction(): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    try {
        await setBillingRates(null);
        await recordAudit({ actorId: admin.id, action: "billing.rates.clear", targetType: "instance" });
        revalidatePath("/admin/billing");
        return {};
    } catch (caught) {
        console.error("polaris: the prices could not be cleared:", caught);
        return { error: "The prices could not be removed. Try again." };
    }
}
