"use server";

/**
 * Container registry logins: the Registries screen and a service's pick.
 *
 * Every action answers with a sentence for the screen, never a secret. A
 * refusal of the registry service is translated; anything else is logged here
 * and replaced with a generic sentence, since it can name internals.
 */

import { revalidatePath } from "next/cache";
import { requirePermission, userHasManage } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as registries from "@/lib/registry-credential-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import type { RegistryFormValues } from "@/lib/registries/registry-form";

const REGISTRIES_PATH = "/apps/deploy/registries";

async function failure(caught: unknown, fallback: string): Promise<string> {
    const t = await getTranslations("deployRegistries");
    if (caught instanceof registries.RegistryRefusal && t.has(caught.key as never)) {
        return t(caught.key as never);
    }
    console.error("[registries]", caught instanceof Error ? caught.message : caught);
    return t(fallback as never);
}

/** The open shelf's logins, and whether this person may change them. */
export async function listRegistriesAction(): Promise<
    (registries.RegistryShelf & { orgId: string | null }) | { error: string }
> {
    const user = await requirePermission("deploy.read");
    const orgId = await scopeOrgIdFor(user.id);
    try {
        const [shelf, mayManage] = await Promise.all([
            registries.listRegistries(user, orgId),
            userHasManage(user, "deploy.manage")
        ]);
        return { ...shelf, canManage: shelf.canManage && mayManage, orgId };
    } catch (caught) {
        return { error: await failure(caught, "errors.loadFailed") };
    }
}

export async function createRegistryAction(
    values: RegistryFormValues
): Promise<{ registry?: registries.RegistryView; error?: string }> {
    const user = await requirePermission("deploy.manage");
    const orgId = await scopeOrgIdFor(user.id);
    try {
        const registry = await registries.createRegistry(user, orgId, values);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.registry.save",
            targetType: "registry",
            targetId: registry.id,
            ...(orgId ? { orgId } : {}),
            metadata: { registry: registry.registry }
        });
        revalidatePath(REGISTRIES_PATH);
        return { registry };
    } catch (caught) {
        return { error: await failure(caught, "errors.saveFailed") };
    }
}

export async function updateRegistryAction(
    id: string,
    values: RegistryFormValues
): Promise<{ registry?: registries.RegistryView; error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const registry = await registries.updateRegistry(user, id, values);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.registry.save",
            targetType: "registry",
            targetId: id,
            ...(registry.orgId ? { orgId: registry.orgId } : {}),
            metadata: { registry: registry.registry }
        });
        revalidatePath(REGISTRIES_PATH);
        return { registry };
    } catch (caught) {
        return { error: await failure(caught, "errors.saveFailed") };
    }
}

export async function deleteRegistryAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const removed = await registries.deleteRegistry(user, id);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.registry.delete",
            targetType: "registry",
            targetId: id,
            ...(removed.orgId ? { orgId: removed.orgId } : {}),
            metadata: { registry: removed.registry }
        });
        revalidatePath(REGISTRIES_PATH);
        return {};
    } catch (caught) {
        return { error: await failure(caught, "errors.deleteFailed") };
    }
}

/** Signs in with a stored login, or with the values of an unsaved form. */
export async function testRegistryAction(input: {
    id?: string;
    values?: RegistryFormValues;
}): Promise<{ result?: registries.RegistryTestResult; error?: string }> {
    const user = await requirePermission("deploy.manage");
    const orgId = await scopeOrgIdFor(user.id);
    try {
        return { result: await registries.testRegistry(user, { ...input, orgId }) };
    } catch (caught) {
        return { error: await failure(caught, "errors.testFailed") };
    }
}

/** What a service may pull with, and what it picked. */
export async function serviceRegistriesAction(
    applicationId: string
): Promise<registries.ServiceRegistryChoice | { error: string }> {
    const user = await requirePermission("deploy.read");
    try {
        await requireApplicationAccess(applicationId, user.id, "project.read");
        return await registries.registriesForApplication(applicationId);
    } catch (caught) {
        return { error: await failure(caught, "errors.loadFailed") };
    }
}

export async function setServiceRegistryAction(
    applicationId: string,
    registryId: string | null
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await requireApplicationAccess(applicationId, user.id, "service.configure");
        await registries.setApplicationRegistry(applicationId, registryId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.registry",
            targetType: "application",
            targetId: applicationId,
            metadata: { registryId }
        });
        return {};
    } catch (caught) {
        return { error: await failure(caught, "errors.saveFailed") };
    }
}
