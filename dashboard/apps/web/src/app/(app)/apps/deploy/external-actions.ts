"use server";

/**
 * The services this project runs somewhere that is not Polaris.
 *
 * Every one of these resolves the session and the project access again, because
 * what a form sends is a claim and not a permission. The capabilities are the
 * ones Deploy already has: reading the board is reading the project, adding one
 * is creating a service, taking it off is deleting one, and releasing it again is
 * running a deploy - a service on Vercel is still a service, and somebody who may
 * not deploy here may not deploy there from here either.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { listConnections } from "@/lib/connections/store";
import * as external from "@/lib/deploy/external-services";
import { requireProjectAccess } from "@/lib/deploy-project-access";
import type { ProviderChoice } from "@/lib/deploy/providers/contract";

const idSchema = z.string().uuid();

const addSchema = z.object({
    environmentId: z.string().uuid(),
    connectionId: z.string().uuid(),
    name: z.string().trim().min(1, "Give it a name").max(60),
    externalId: z.string().trim().min(1).max(200),
    ref: z.record(z.string().max(40), z.string().max(200)).default({})
});

/** The sentence a screen shows, from whatever came back. A provider's own words
 *  where there are any: they are written for somebody who has to go and fix it. */
function refusal(caught: unknown): string {
    return caught instanceof Error ? caught.message : "That did not work";
}

/** The accounts this person has linked that can run a service, for the picker. */
export async function listProviderAccountsAction(): Promise<{
    accounts?: { id: string; provider: string; label: string }[];
    error?: string;
}> {
    const user = await requirePermission("deploy.read");
    const links = await listConnections(user.id);
    return {
        accounts: links
            .filter((link) => external.isProvider(link.provider))
            .map((link) => ({ id: link.id, provider: link.provider, label: link.label }))
    };
}

/** What one linked account holds, so somebody can point at one of them. */
export async function listProviderChoicesAction(
    connectionId: string
): Promise<{ choices?: ProviderChoice[]; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(connectionId);
    if (!parsed.success) return { error: "Unknown account" };
    try {
        return { choices: await external.providerChoices(user.id, parsed.data) };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

export async function addExternalServiceAction(
    projectId: string,
    input: unknown
): Promise<{ service?: external.ExternalServiceView; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = addSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await requireProjectAccess(projectId, user.id, "service.create");
        const service = await external.addExternalService(user.id, projectId, parsed.data);
        revalidatePath(`/apps/deploy/${projectId}/elsewhere`);
        return { service };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

/** Ask the provider what it is doing now. A read, so it is the reading
 *  capability: watching a build is not deploying one. */
export async function refreshExternalServiceAction(
    projectId: string,
    id: string
): Promise<{ service?: external.ExternalServiceView; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: "Unknown service" };
    try {
        await requireProjectAccess(projectId, user.id, "project.read");
        return { service: await external.refreshExternalService(projectId, parsed.data) };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

/** Release it again, at the provider. */
export async function deployExternalServiceAction(
    projectId: string,
    id: string
): Promise<{ service?: external.ExternalServiceView; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: "Unknown service" };
    try {
        await requireProjectAccess(projectId, user.id, "deploy.run");
        return { service: await external.deployExternalService(projectId, parsed.data) };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

export async function renameExternalServiceAction(
    projectId: string,
    id: string,
    name: string
): Promise<{ service?: external.ExternalServiceView; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: "Unknown service" };
    const named = z.string().trim().min(1, "Give it a name").max(60).safeParse(name);
    if (!named.success) return { error: named.error.issues[0]?.message ?? "Give it a name" };
    try {
        await requireProjectAccess(projectId, user.id, "service.configure");
        return { service: await external.renameExternalService(projectId, parsed.data, named.data) };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

/** Take it off this board. Nothing is deleted at the provider: it is their
 *  service, and Polaris only ever had a link to it. */
export async function removeExternalServiceAction(
    projectId: string,
    id: string
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: "Unknown service" };
    try {
        await requireProjectAccess(projectId, user.id, "service.delete");
        await external.removeExternalService(projectId, parsed.data);
        revalidatePath(`/apps/deploy/${projectId}/elsewhere`);
        return {};
    } catch (caught) {
        return { error: refusal(caught) };
    }
}
