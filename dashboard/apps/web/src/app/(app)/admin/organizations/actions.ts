"use server";

/**
 * What this deployment lets organizations be. Admin-only, and audited like any
 * other platform setting: turning creation off or capping a roster changes what
 * everybody on the instance can do.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { organizationPolicySchema } from "@polaris/core";
import { setOrganizationPolicy } from "@/lib/orgs/policy";
import type { Page } from "@/lib/pagination/cursor";
import {
    listOrgDirectoryPage,
    orgDirectoryQuerySchema,
    type OrgDirectoryQuery,
    type OrgDirectoryRow
} from "@/lib/org-directory";

export async function saveOrganizationPolicyAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = organizationPolicySchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("admin");
        return { error: parsed.error.issues[0]?.message ?? t("organizations.errors.checkLimits") };
    }
    await setOrganizationPolicy(parsed.data);
    await recordAudit({ actorId: admin.id, action: "admin.organizations.updated" });
    // The account menu and the Tasks sidebar both read this, so the whole tree
    // follows from the next render.
    revalidatePath("/", "layout");
    return {};
}

/** A page of the organizations list, narrowed by what was typed. */
export async function listOrgDirectoryAction(input: OrgDirectoryQuery): Promise<Page<OrgDirectoryRow> | { error: string }> {
    await requireAdmin();
    const parsed = orgDirectoryQuerySchema.safeParse(input);
    const t = await getTranslations("admin");
    if (!parsed.success) return { error: t("users.directory.loadFailed") };
    try {
        return await listOrgDirectoryPage(parsed.data);
    } catch {
        return { error: t("users.directory.loadFailed") };
    }
}
