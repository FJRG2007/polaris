"use server";

/**
 * Reading and setting what an organization may hold.
 *
 * Anybody on the roster may read the limits and the usage against them: they are
 * what decides whether the next project is refused, and a person should find out
 * here rather than from the refusal. Only an administrator of this Polaris sets
 * them - an organization that could raise its own caps would have none. Each
 * change is written into the organization's own history.
 */

import { requireUser } from "@/lib/session";
import { revalidatePath } from "next/cache";
import * as quotas from "@/lib/orgs/quotas";
import * as orgs from "@/lib/orgs/org-service";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import * as quotaService from "@/lib/orgs/quota-service";

export interface OrgQuotaView {
    limits: quotas.OrgQuotaLimits;
    usage: quotas.OrgQuotaUsage;
}

async function failure(
    caught: unknown,
    fallback: NamespaceKey<"accountOrgs">
): Promise<{ error: string }> {
    if (caught instanceof orgs.OrgError) return { error: caught.message };
    console.error(caught);
    return { error: (await getTranslations("accountOrgs"))(fallback) };
}

export async function loadOrgQuotaAction(
    orgId: string
): Promise<{ view?: OrgQuotaView; error?: string }> {
    const user = await requireUser();
    try {
        await orgs.requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "org.read");
        const [limits, usage] = await Promise.all([
            quotaService.getOrgQuota(orgId),
            quotaService.orgQuotaUsage(orgId)
        ]);
        return { view: { limits: limits ?? quotas.NO_ORG_QUOTA, usage } };
    } catch (caught) {
        return failure(caught, "quotas.loadFailed");
    }
}

export async function saveOrgQuotaAction(
    orgId: string,
    input: unknown
): Promise<{ limits?: quotas.OrgQuotaLimits; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("accountOrgs");
    // Checked here, not only by hiding the fields: the action is callable by
    // anybody who can reach the page.
    if (!user.isAdmin) return { error: t("quotas.adminsOnly") };
    const parsed = quotas.orgQuotaInputSchema.safeParse(input);
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "quotas.issues.number";
        return {
            error: message.startsWith("quotas.issues.")
                ? t(message as NamespaceKey<"accountOrgs">)
                : t("quotas.issues.number")
        };
    }
    try {
        await orgs.requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "org.read");
        await quotaService.setOrgQuota(orgId, parsed.data);
        await recordAudit({
            actorId: user.id,
            orgId,
            action: "org.quota",
            targetType: "org",
            targetId: orgId,
            metadata: { ...parsed.data }
        });
        revalidatePath("/account/organizations", "layout");
        return { limits: parsed.data };
    } catch (caught) {
        return failure(caught, "quotas.saveFailed");
    }
}
