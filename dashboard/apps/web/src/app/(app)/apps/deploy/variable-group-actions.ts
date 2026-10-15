"use server";

/**
 * Server actions for variable groups (lib/deploy/variable-groups) and the tags
 * on projects and services.
 *
 * A group's variables are edited through the ordinary variable actions with
 * scope "group"; this file owns the groups themselves, the links from a
 * service, what a service resolves to, and tags. Every action checks the
 * instance permission, then the project capability or the group right.
 */

import { z } from "zod";
import { reply } from "./reply";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as groups from "@/lib/deploy/variable-groups";
import { accessCan, requireApplicationAccess, requireProjectAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

type Result<T extends object = Record<never, never>> = { error?: string } & Partial<T>;

const id = z.string().trim().min(1).max(100);
const groupInput = core.variableGroupInputSchema;
const groupUpdate = core.variableGroupInputSchema.extend({ groupId: id });
const linkInput = z.object({ applicationId: id, groupId: id });
const projectTagsInput = z.object({ projectId: id, tags: core.tagsSchema });
const serviceTagsInput = z.object({ applicationId: id, tags: core.tagsSchema });

/** A refusal said in the reader's language; anything unexpected is generic. */
async function failure(caught: unknown): Promise<{ error: string }> {
    if (caught instanceof groups.VariableGroupError)
        return { error: await reply(`variableGroups.${caught.code}`) };
    return { error: await reply("variableGroups.failed") };
}

export interface VariableGroupsView {
    groups: groups.VariableGroupSummary[];
    canCreate: boolean;
}

/** The groups on the shelf that is open. */
export async function listVariableGroupsAction(): Promise<Result<VariableGroupsView>> {
    const user = await requirePermission("deploy.read");
    try {
        return await groups.listGroups(user, await scopeOrgIdFor(user.id));
    } catch (caught) {
        return failure(caught);
    }
}

export async function createVariableGroupAction(input: unknown): Promise<Result<{ id: string }>> {
    const user = await requirePermission("deploy.read");
    const parsed = groupInput.safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.nameRequired") };
    try {
        const orgId = await scopeOrgIdFor(user.id);
        const created = await groups.createGroup(user, orgId, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            orgId: orgId ?? undefined,
            action: "deploy.variable-group.create",
            targetType: "variable-group",
            targetId: created.id
        });
        revalidatePath(DEPLOY_PATH);
        return created;
    } catch (caught) {
        return failure(caught);
    }
}

export async function updateVariableGroupAction(input: unknown): Promise<Result> {
    const user = await requirePermission("deploy.read");
    const parsed = groupUpdate.safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.nameRequired") };
    try {
        await groups.updateGroup(user, parsed.data.groupId, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.variable-group.update",
            targetType: "variable-group",
            targetId: parsed.data.groupId
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught);
    }
}

export async function deleteVariableGroupAction(input: unknown): Promise<Result<{ linked: number }>> {
    const user = await requirePermission("deploy.read");
    const parsed = z.object({ groupId: id }).safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.notFound") };
    try {
        const result = await groups.deleteGroup(user, parsed.data.groupId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.variable-group.delete",
            targetType: "variable-group",
            targetId: parsed.data.groupId,
            metadata: { linked: result.linked }
        });
        revalidatePath(DEPLOY_PATH);
        return result;
    } catch (caught) {
        return failure(caught);
    }
}

export interface ServiceGroupsView {
    linked: groups.LinkedGroupView[];
    linkable: Array<{ id: string; name: string }>;
    resolved: groups.ResolvedVariableView[];
    /** Whether the reader may link and unlink groups here. */
    canLink: boolean;
    /** Whether the service is running, so a change only lands on a redeploy. */
    deployed: boolean;
}

/** A service's linked groups, what it could link, and the resolved order. */
export async function serviceVariableGroupsAction(
    input: unknown
): Promise<Result<ServiceGroupsView>> {
    const user = await requirePermission("deploy.read");
    const parsed = z.object({ applicationId: id }).safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.notFound") };
    try {
        const { applicationId } = parsed.data;
        const access = await requireApplicationAccess(applicationId, user.id, "variables.read");
        const canLink = accessCan(access, "variables.write");
        const [linked, linkable, resolved, app] = await Promise.all([
            groups.linkedGroups(user, applicationId),
            canLink ? groups.linkableGroups(user, applicationId) : [],
            groups.resolvedVariables(user, applicationId, access.environmentId),
            prisma.application.findUnique({
                where: { id: applicationId },
                select: { currentDeploymentId: true }
            })
        ]);
        return { linked, linkable, resolved, canLink, deployed: Boolean(app?.currentDeploymentId) };
    } catch (caught) {
        return failure(caught);
    }
}

async function changeLink(
    input: unknown,
    change: (actor: { id: string; isAdmin: boolean }, applicationId: string, groupId: string) => Promise<void>,
    action: string
): Promise<Result> {
    const user = await requirePermission("deploy.read");
    const parsed = linkInput.safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.notFound") };
    try {
        const { applicationId, groupId } = parsed.data;
        await requireApplicationAccess(applicationId, user.id, "variables.write");
        await change(user, applicationId, groupId);
        await recordDeployAudit({
            actorId: user.id,
            action,
            targetType: "application",
            targetId: applicationId,
            metadata: { groupId }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught);
    }
}

/** Link a group the reader may read, on the service's own shelf. */
export async function linkVariableGroupAction(input: unknown): Promise<Result> {
    return changeLink(input, groups.linkGroup, "deploy.variable-group.link");
}

export async function unlinkVariableGroupAction(input: unknown): Promise<Result> {
    return changeLink(
        input,
        (_actor, applicationId, groupId) => groups.unlinkGroup(applicationId, groupId),
        "deploy.variable-group.unlink"
    );
}

/** The services a group reaches that are running, so its editor can say a
 *  change waits for a redeploy. Group readers only. */
export async function variableGroupReachAction(
    input: unknown
): Promise<Result<{ deployed: number; canEdit: boolean }>> {
    const user = await requirePermission("deploy.read");
    const parsed = z.object({ groupId: id }).safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.notFound") };
    try {
        const rights = await groups.requireGroup(user, parsed.data.groupId, "read");
        const deployed = await groups.deployedServicesLinking(rights.id);
        return { deployed: deployed.length, canEdit: rights.canEdit };
    } catch (caught) {
        return failure(caught);
    }
}

export async function setProjectTagsAction(input: unknown): Promise<Result<{ tags: string[] }>> {
    const user = await requirePermission("deploy.manage");
    const parsed = projectTagsInput.safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.tagsInvalid") };
    try {
        await requireProjectAccess(parsed.data.projectId, user.id, "project.settings");
        await prisma.project.update({
            where: { id: parsed.data.projectId },
            data: { tags: JSON.stringify(parsed.data.tags) }
        });
        revalidatePath(DEPLOY_PATH, "layout");
        return { tags: parsed.data.tags };
    } catch {
        return { error: await reply("variableGroups.tagsFailed") };
    }
}

export async function setServiceTagsAction(input: unknown): Promise<Result<{ tags: string[] }>> {
    const user = await requirePermission("deploy.manage");
    const parsed = serviceTagsInput.safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.tagsInvalid") };
    try {
        await requireApplicationAccess(parsed.data.applicationId, user.id, "service.configure");
        await prisma.application.update({
            where: { id: parsed.data.applicationId },
            data: { tags: JSON.stringify(parsed.data.tags) }
        });
        revalidatePath(DEPLOY_PATH, "layout");
        return { tags: parsed.data.tags };
    } catch {
        return { error: await reply("variableGroups.tagsFailed") };
    }
}

/** A service's tags, for its settings. */
export async function serviceTagsAction(
    input: unknown
): Promise<Result<{ tags: string[]; canEdit: boolean }>> {
    const user = await requirePermission("deploy.read");
    const parsed = z.object({ applicationId: id }).safeParse(input);
    if (!parsed.success) return { error: await reply("variableGroups.notFound") };
    try {
        const access = await requireApplicationAccess(parsed.data.applicationId, user.id, "project.read");
        const app = await prisma.application.findUnique({
            where: { id: parsed.data.applicationId },
            select: { tags: true }
        });
        return { tags: core.parseTags(app?.tags), canEdit: accessCan(access, "service.configure") };
    } catch {
        return { error: await reply("variableGroups.notFound") };
    }
}
