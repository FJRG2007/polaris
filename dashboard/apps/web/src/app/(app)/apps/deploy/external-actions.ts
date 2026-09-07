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
import * as migrate from "@/lib/deploy/migrate";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import type { ProjectCapability } from "@polaris/core";
import { listConnections } from "@/lib/connections/store";
import * as external from "@/lib/deploy/external-services";
import { listDeployTargets } from "@/lib/deploy-target-service";
import type { ProviderChoice } from "@/lib/deploy/providers/contract";
import {
    accessCan,
    requireEnvironmentAccess,
    requireProjectAccess
} from "@/lib/deploy-project-access";

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

/* -------------------------------------------------------------------------- */
/* Moving one, either way                                                     */
/* -------------------------------------------------------------------------- */

const moveOutSchema = z.object({
    connectionId: z.string().uuid(),
    externalId: z.string().trim().min(1).max(200),
    ref: z.record(z.string().max(40), z.string().max(200)).default({}),
    name: z.string().trim().min(1, "Give it a name").max(60),
    environmentId: z.string().uuid(),
    copyVariables: z.boolean().default(true),
    stopHere: z.boolean().default(true),
    releaseThere: z.boolean().default(true)
});

const moveHomeSchema = z.object({
    environmentId: z.string().uuid(),
    targetId: z.string().uuid(),
    name: z.string().trim().min(1, "Give it a name").max(60),
    repoUrl: z.string().trim().min(1, "Polaris needs the repository").max(500),
    branch: z.string().trim().max(200).default(""),
    copyVariables: z.boolean().default(true),
    deployNow: z.boolean().default(true)
});

/**
 * Whether the variables may travel with the move, in each direction.
 *
 * Not covered by the capabilities that create and configure a service, and
 * deliberately not: a set assembled to withhold the variables withholds their
 * names as well as their values, and a move that copies them into somebody's own
 * Vercel project is the widest read of them there is. So the plans below hand
 * over how many there are and nothing more, and the move itself refuses to carry
 * them.
 *
 * Coming the other way it is a write rather than a read - a provider's values
 * land in this project's own variables - so it is the writing capability.
 */
const COPY_OUT: ProjectCapability = "variables.read";
const COPY_HOME: ProjectCapability = "variables.write";

/** What a service here would take with it. A read of the project, which is what
 *  it is: nothing has been asked to move yet. */
export async function moveOutPlanAction(
    projectId: string,
    applicationId: string
): Promise<{ plan?: migrate.MoveOutPlan; canCopyVariables?: boolean; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(applicationId);
    if (!parsed.success) return { error: "Unknown service" };
    try {
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        const canCopyVariables = accessCan(access, COPY_OUT);
        const plan = await migrate.moveOutPlan(projectId, parsed.data);
        // The count travels either way; the names only to somebody who may read
        // them. "There are none" and "they are not yours to see" are different
        // sentences and the screen has to be able to say the second one.
        return {
            plan: canCopyVariables ? plan : { ...plan, variableKeys: [] },
            canCopyVariables
        };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

/**
 * Send a service to a provider.
 *
 * Creating a service and stopping one, so it asks for both capabilities rather
 * than the weaker of them: this is the button that takes production off a
 * Polaris server, and somebody who may only start builds is not the person who
 * decides that. Carrying the variables asks for a third, because that half of it
 * is a read of every secret the service holds.
 */
export async function moveOutAction(
    projectId: string,
    applicationId: string,
    input: unknown
): Promise<{ result?: migrate.MoveOutResult; error?: string }> {
    const user = await requirePermission("deploy.read");
    const service = idSchema.safeParse(applicationId);
    if (!service.success) return { error: "Unknown service" };
    const parsed = moveOutSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // Reached through the environment the row lands in rather than through
        // the project, so an access limited to development cannot put one in
        // production - and checked against this project, because the id came off
        // a form and a form is a claim.
        const access = await requireEnvironmentAccess(
            parsed.data.environmentId,
            user.id,
            "service.create"
        );
        if (access.projectId !== projectId) return { error: "Project not found" };
        if (!accessCan(access, "service.configure")) return { error: "Project not found" };
        if (parsed.data.copyVariables && !accessCan(access, COPY_OUT)) {
            return {
                error: "Copying the variables needs access to them. Move it without them, or ask for that access."
            };
        }
        const result = await migrate.moveOut(user.id, projectId, service.data, parsed.data);
        // The one action here worth a trail: it decrypts every secret the service
        // runs with and hands them to a third party.
        await recordAudit({
            actorId: user.id,
            action: "deploy.app.moveOut",
            targetType: "application",
            targetId: service.data,
            metadata: {
                projectId,
                provider: result.service.provider,
                copied: result.copied,
                stopped: result.stopped
            }
        });
        revalidatePath(`/apps/deploy/${projectId}`);
        revalidatePath(`/apps/deploy/${projectId}/elsewhere`);
        return { result };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

/** What a service out there would bring with it, and the servers it could run
 *  on here. Asked together because the dialog needs both before it can draw. */
export async function moveHomePlanAction(
    projectId: string,
    serviceId: string
): Promise<{
    plan?: migrate.MoveHomePlan;
    targets?: { id: string; name: string }[];
    canCopyVariables?: boolean;
    error?: string;
}> {
    const user = await requirePermission("deploy.read");
    const parsed = idSchema.safeParse(serviceId);
    if (!parsed.success) return { error: "Unknown service" };
    try {
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        const [plan, targets] = await Promise.all([
            migrate.moveHomePlan(projectId, parsed.data),
            listDeployTargets(access.ownerId)
        ]);
        return {
            plan: accessCan(access, COPY_OUT) ? plan : { ...plan, variableKeys: [] },
            canCopyVariables: accessCan(access, COPY_HOME),
            targets: targets.map((target) => ({ id: target.id, name: target.name }))
        };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}

/** Build and run a provider's service here instead. The provider's own project
 *  is untouched and stays on the board. */
export async function moveHomeAction(
    projectId: string,
    serviceId: string,
    input: unknown
): Promise<{ result?: migrate.MoveHomeResult; error?: string }> {
    const user = await requirePermission("deploy.read");
    const service = idSchema.safeParse(serviceId);
    if (!service.success) return { error: "Unknown service" };
    const parsed = moveHomeSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // The environment is where the new service is created, and it arrives on
        // a form. Authorized through itself rather than through the project:
        // `createApplication` only checks that the environment belongs to the
        // same owner, so an id from a sibling project would otherwise be enough
        // to plant a running service - and its variables - somewhere this person
        // has no access at all.
        const access = await requireEnvironmentAccess(
            parsed.data.environmentId,
            user.id,
            "service.create"
        );
        if (access.projectId !== projectId) return { error: "Project not found" };
        if (parsed.data.copyVariables && !accessCan(access, COPY_HOME)) {
            return {
                error: "Copying the variables needs access to them. Bring it over without them, or ask for that access."
            };
        }
        const result = await migrate.moveHome(user.id, projectId, service.data, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "deploy.app.moveHome",
            targetType: "application",
            targetId: result.applicationId,
            metadata: { projectId, externalServiceId: service.data, copied: result.copied }
        });
        revalidatePath(`/apps/deploy/${projectId}`);
        return { result };
    } catch (caught) {
        return { error: refusal(caught) };
    }
}
