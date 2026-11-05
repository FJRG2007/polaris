"use server";

/**
 * The pages of deploy servers and services a picker shows, for whoever is
 * signed in, behind the same gate as the action the pick is for.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireAdmin, requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { requireProjectAccess } from "@/lib/deploy-project-access";
import {
    deployTargetOptionsRequestSchema,
    serviceOptionsRequestSchema,
    templateEnvironmentOptionsRequestSchema,
    templateProjectOptionsRequestSchema,
    type DeployTargetOption,
    type ServiceOption,
    type TemplateEnvironmentOption,
    type TemplateProjectOption
} from "@/lib/deploy-target-options-schema";
import {
    readDeployTargetOptions,
    readServiceOptions,
    readTemplateEnvironmentOptions,
    readTemplateProjectOptions,
    type OptionsPage
} from "@/lib/deploy-target-options";

export async function listDeployTargetOptionsAction(
    input: unknown
): Promise<OptionsPage<DeployTargetOption> | { error: string }> {
    const parsed = deployTargetOptionsRequestSchema.safeParse(input);
    // The relay is chosen on an admin screen; a tunnel's public end under
    // deploy.manage, as creating the tunnel is; a project's servers under
    // deploy.read and read access to the project, as the move-home plan read them.
    const scope = parsed.success ? parsed.data.scope : "mine";
    const user =
        scope === "relay"
            ? await requireAdmin()
            : await requirePermission(scope === "project" ? "deploy.read" : "deploy.manage");
    const t = await getTranslations("components");
    if (!parsed.success) return { error: t("asyncSelect.failed") };
    try {
        const ownerId = parsed.data.projectId
            ? (await requireProjectAccess(parsed.data.projectId, user.id, "project.read")).ownerId
            : user.id;
        return await readDeployTargetOptions(ownerId, parsed.data.scope, parsed.data);
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

/** The projects a marketplace template can go into, on the shelf that is open,
 *  under deploy.manage as creating the service from it is. */
export async function templateProjectOptionsAction(
    input: unknown
): Promise<OptionsPage<TemplateProjectOption> | { error: string }> {
    const user = await requirePermission("deploy.manage");
    const t = await getTranslations("components");
    const parsed = templateProjectOptionsRequestSchema.safeParse(input);
    if (!parsed.success) return { error: t("asyncSelect.failed") };
    try {
        return await readTemplateProjectOptions(user.id, await scopeOrgIdFor(user.id), parsed.data);
    } catch (error) {
        console.error("[template-project-options] read failed", error);
        return { error: t("asyncSelect.failed") };
    }
}

/** The environments of one of those projects. */
export async function templateEnvironmentOptionsAction(
    input: unknown
): Promise<OptionsPage<TemplateEnvironmentOption> | { error: string }> {
    const user = await requirePermission("deploy.manage");
    const t = await getTranslations("components");
    const parsed = templateEnvironmentOptionsRequestSchema.safeParse(input);
    if (!parsed.success) return { error: t("asyncSelect.failed") };
    try {
        const { projectId, ...page } = parsed.data;
        const orgId = await scopeOrgIdFor(user.id);
        return await readTemplateEnvironmentOptions(user.id, orgId, projectId, page);
    } catch (error) {
        console.error("[template-environment-options] read failed", error);
        return { error: t("asyncSelect.failed") };
    }
}
