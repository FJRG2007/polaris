"use server";

/**
 * The pages of deploy servers and services a picker shows, for whoever is
 * signed in, behind the same gate as the action the pick is for.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireAdmin, requirePermission } from "@/lib/session";
import {
    deployTargetOptionsRequestSchema,
    serviceOptionsRequestSchema,
    type DeployTargetOption,
    type ServiceOption
} from "@/lib/deploy-target-options-schema";
import {
    readDeployTargetOptions,
    readServiceOptions,
    type OptionsPage
} from "@/lib/deploy-target-options";

export async function listDeployTargetOptionsAction(
    input: unknown
): Promise<OptionsPage<DeployTargetOption> | { error: string }> {
    const parsed = deployTargetOptionsRequestSchema.safeParse(input);
    // The relay is chosen on an admin screen; a tunnel's public end under
    // deploy.manage, as creating the tunnel is.
    const user =
        parsed.success && parsed.data.scope === "relay"
            ? await requireAdmin()
            : await requirePermission("deploy.manage");
    const t = await getTranslations("components");
    if (!parsed.success) return { error: t("asyncSelect.failed") };
    try {
        return await readDeployTargetOptions(user.id, parsed.data.scope, parsed.data);
    } catch (error) {
        console.error("[deploy-target-options] read failed", error);
        return { error: t("asyncSelect.failed") };
    }
}

export async function listServiceOptionsAction(
    input: unknown
): Promise<OptionsPage<ServiceOption> | { error: string }> {
    const user = await requirePermission("deploy.manage");
    const t = await getTranslations("components");
    const parsed = serviceOptionsRequestSchema.safeParse(input);
    if (!parsed.success) return { error: t("asyncSelect.failed") };
    try {
        return await readServiceOptions(user.id, parsed.data);
    } catch (error) {
        console.error("[service-options] read failed", error);
        return { error: t("asyncSelect.failed") };
    }
}
