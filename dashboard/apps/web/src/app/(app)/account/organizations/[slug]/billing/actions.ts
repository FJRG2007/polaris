"use server";

/**
 * Setting and removing an organization's monthly budget.
 *
 * The permission is `settings.manage`, the same as every other decision about how
 * the organization is run, and each change is written into the organization's
 * own history. A budget is always in the currency the instance prices in at the
 * moment it is set - there is no other currency the statement could measure it
 * against.
 */

import { requireUser } from "@/lib/session";
import { revalidatePath } from "next/cache";
import * as orgs from "@/lib/orgs/org-service";
import { recordAudit } from "@/lib/audit-service";
import { orgBudgetInputSchema } from "@polaris/core";
import { getBillingRates } from "@/lib/billing/rates";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { orgValidationMessage } from "@/app/(app)/account/organizations/org-validation";
import { clearOrgBudget, setOrgBudget, type OrgBudget } from "@/lib/billing/budgets";

async function failure(caught: unknown, fallback: NamespaceKey<"accountOrgs">): Promise<{ error: string }> {
    if (caught instanceof orgs.OrgError) return { error: caught.message };
    console.error(caught);
    return { error: (await getTranslations("accountOrgs"))(fallback) };
}

export async function saveOrgBudgetAction(
    orgId: string,
    input: unknown
): Promise<{ budget?: OrgBudget; error?: string }> {
    const user = await requireUser();
    const parsed = orgBudgetInputSchema.safeParse(input);
    if (!parsed.success) {
        const [t, tv] = await Promise.all([getTranslations("accountOrgs"), getTranslations("validation")]);
        const message = parsed.error.issues[0]?.message;
        return { error: message === undefined ? t("errors.checkAmount") : orgValidationMessage(t, tv, message) };
    }
    try {
        await orgs.requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "settings.manage");
        const rates = await getBillingRates();
        if (!rates) {
            return { error: (await getTranslations("accountOrgs"))("errors.noPrices") };
        }
        const budget: OrgBudget = { amount: parsed.data.amount, currency: rates.currency };
        await setOrgBudget(orgId, budget);
        await recordAudit({
            actorId: user.id,
            orgId,
            action: "billing.budget",
            targetType: "org",
            targetId: orgId,
            metadata: { ...budget }
        });
        revalidatePath("/account/organizations", "layout");
        return { budget };
    } catch (caught) {
        return failure(caught, "errors.saveBudget");
    }
}

export async function clearOrgBudgetAction(orgId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await orgs.requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "settings.manage");
        await clearOrgBudget(orgId);
        await recordAudit({
            actorId: user.id,
            orgId,
            action: "billing.budget.clear",
            targetType: "org",
            targetId: orgId
        });
        revalidatePath("/account/organizations", "layout");
        return {};
    } catch (caught) {
        return failure(caught, "errors.removeBudget");
    }
}
