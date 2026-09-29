"use server";

/**
 * Server actions for everything a project has that is not a service: its
 * settings, the people on it, its webhooks and tokens, the changeset waiting to
 * be deployed, and its volumes.
 *
 * Every one of these resolves access through deploy-project-access first and
 * then acts as the project's owner, so a member reaches a project through
 * exactly the same owner-scoped queries the owner does - never a second, weaker
 * route in. `deploy.read`/`deploy.manage` still gate the instance; the project
 * role gates the project.
 */

import { firstIssue, reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import type { NamespaceKey } from "@/lib/i18n/types";
import * as deployService from "@/lib/deploy-service";
import * as staged from "@/lib/deploy-staged-changes";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as projectService from "@/lib/deploy-project-service";
import { readMonthToDate, type StatementView } from "@/lib/billing/statement";
import {
    deleteVolume,
    getVolume,
    measureVolumeUsage,
    wipeVolume,
    type VolumeDetail
} from "@/lib/deploy-volume-service";
import {
    accessCan,
    accessInEnvironment,
    requireApplicationAccess,
    requireEnvironmentAccess,
    requireProjectAccess
} from "@/lib/deploy-project-access";
import {
    environmentNameSchema,
    environmentNetworkModeSchema,
    projectAccessInputSchema,
    projectFlagsSchema,
    projectGeneralSchema,
    projectTokenInputSchema,
    projectVisibilitySchema,
    projectWebhookInputSchema,
    type EnvironmentNetworkMode,
    type ProjectAccessInput,
    type ProjectCapability,
    type ProjectFlags,
    type ProjectTokenInput,
    type ProjectVisibility,
    type ProjectWebhookInput
} from "@polaris/core";

const DEPLOY_PATH = "/apps/deploy";

/** What a token that may change things can do through the Deploy API. */
const TOKEN_CHANGE_CAPABILITIES: readonly ProjectCapability[] = ["deploy.run", "variables.write", "domains.manage"];

/** The one shape every action here answers with, so a caller never has to guess
 *  whether a missing `error` means success or a field it forgot to read. */
type Result<T extends object = Record<never, never>> = { error?: string } & Partial<T>;

/** Run the body, turning a thrown message into the error field. Keeps each
 *  action to its actual work instead of an identical try/catch apiece. */
async function attempt<T>(
    fallback: NamespaceKey<"deployServer">,
    body: () => Promise<T>
): Promise<T | { error: string }> {
    try {
        return await body();
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await reply(fallback) };
    }
}

/**
 * Invalidate everything under the project, layout included.
 *
 * The default revalidation only reaches the page segment, and the changeset
 * banner lives in the project's layout - so staging a removal would write the
 * change, refresh the canvas, and leave the banner that is supposed to announce
 * it showing the state from before.
 */
function refresh(projectId: string): void {
    revalidatePath(`${DEPLOY_PATH}/${projectId}`, "layout");
}

// ---------------------------------------------------------------------------
// General, visibility, flags
// ---------------------------------------------------------------------------

export async function projectSettingsAction(
    projectId: string
): Promise<Result<{ settings: projectService.ProjectSettingsView; canManage: boolean }>> {
    return attempt("settings.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        return {
            settings: await projectService.getProjectSettings(projectId),
            canManage: accessCan(access, "project.settings")
        };
    });
}

export async function updateProjectGeneralAction(input: {
    projectId: string;
    name: string;
    description: string;
}): Promise<Result> {
    return attempt("settings.saveFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = projectGeneralSchema.safeParse(input);
        if (!parsed.success) return { error: await firstIssue(parsed.error, "common.checkForm") };
        const access = await requireProjectAccess(
            parsed.data.projectId,
            user.id,
            "project.settings"
        );
        await projectService.updateProjectGeneral({
            projectId: parsed.data.projectId,
            ownerId: access.ownerId,
            name: parsed.data.name,
            description: parsed.data.description
        });
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.update",
            targetType: "project",
            targetId: parsed.data.projectId
        });
        refresh(parsed.data.projectId);
        return {};
    });
}

export async function setProjectVisibilityAction(input: {
    projectId: string;
    visibility: ProjectVisibility;
}): Promise<Result> {
    return attempt("settings.visibilityFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = projectVisibilitySchema.safeParse(input);
        if (!parsed.success) return { error: await reply("settings.visibilityUnknown") };
        await requireProjectAccess(parsed.data.projectId, user.id, "project.settings");
        await projectService.setProjectVisibility(parsed.data.projectId, parsed.data.visibility);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.visibility",
            targetType: "project",
            targetId: parsed.data.projectId,
            metadata: { visibility: parsed.data.visibility }
        });
        refresh(parsed.data.projectId);
        return {};
    });
}

export async function setProjectFlagsAction(input: {
    projectId: string;
    flags: ProjectFlags;
}): Promise<Result> {
    return attempt("settings.flagsFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = projectFlagsSchema.safeParse(input.flags);
        if (!parsed.success) return { error: await reply("settings.unreadable") };
        await requireProjectAccess(input.projectId, user.id, "project.settings");
        await projectService.setProjectFlags(input.projectId, parsed.data as ProjectFlags);
        refresh(input.projectId);
        return {};
    });
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export async function renameEnvironmentAction(input: {
    environmentId: string;
    name: string;
}): Promise<Result> {
    return attempt("environment.renameFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = environmentNameSchema.safeParse(input);
        if (!parsed.success) return { error: await firstIssue(parsed.error, "environment.checkName") };
        const access = await requireEnvironmentAccess(
            parsed.data.environmentId,
            user.id,
            "project.settings"
        );
        await deployService.renameEnvironment(
            parsed.data.environmentId,
            access.ownerId,
            parsed.data.name
        );
        refresh(access.projectId);
        return {};
    });
}

export async function setDefaultEnvironmentAction(environmentId: string): Promise<Result> {
    return attempt("environment.defaultFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const access = await requireEnvironmentAccess(environmentId, user.id, "project.settings");
        await deployService.setDefaultEnvironment(environmentId, access.ownerId);
        refresh(access.projectId);
        return {};
    });
}

/**
 * Choose how an environment's services see each other, and optionally deploy it
 * at once so the choice takes effect now. Changing it needs the settings
 * capability; deploying everything in it on top needs the deploy one too.
 */
export async function setEnvironmentNetworkModeAction(input: {
    environmentId: string;
    networkMode: EnvironmentNetworkMode;
    apply?: boolean;
}): Promise<Result<{ started: number; failed: string[] }>> {
    return attempt("environment.networkFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = environmentNetworkModeSchema.safeParse(input);
        if (!parsed.success) return { error: await reply("common.pickOption") };
        const access = await requireEnvironmentAccess(
            parsed.data.environmentId,
            user.id,
            "project.settings"
        );
        if (parsed.data.apply && !accessCan(access, "deploy.run")) {
            return { error: await reply("environment.networkCannotDeploy") };
        }
        const { previous } = await deployService.setEnvironmentNetworkMode(
            parsed.data.environmentId,
            access.ownerId,
            parsed.data.networkMode
        );
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.env.network",
            targetType: "environment",
            targetId: parsed.data.environmentId,
            metadata: { from: previous, to: parsed.data.networkMode, applied: parsed.data.apply }
        });
        refresh(access.projectId);
        if (!parsed.data.apply) return {};
        const { deployEnvironment } = await import("@/lib/deploy/environments");
        const result = await deployEnvironment(parsed.data.environmentId, access.ownerId, user.id);
        return { started: result.started, failed: result.failed };
    });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listProjectMembersAction(projectId: string): Promise<
    Result<{
        members: projectService.ProjectMemberView[];
        canManage: boolean;
        /** What the reader may hand on: an entry never reaches further than the
         *  person writing it, so the editor offers exactly this and no more. */
        grantable: ProjectCapability[];
        grantableEnvironmentIds: string[] | null;
    }>
> {
    return attempt("members.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        return {
            members: await projectService.listProjectMembers(projectId, {
                id: user.id,
                isAdmin: user.isAdmin
            }),
            canManage: accessCan(access, "members.manage"),
            grantable: [...access.capabilities],
            grantableEnvironmentIds: access.environmentIds ? [...access.environmentIds] : null
        };
    });
}

/**
 * Write one access entry - a person, a team, an organization, or everyone with
 * an account - creating it or replacing what that principal already held.
 *
 * One action for adding and for editing, because they are the same write: a
 * second entry for the same principal would be a second answer to a question
 * that has one.
 */
export async function setProjectAccessAction(input: ProjectAccessInput): Promise<Result> {
    return attempt("members.saveFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = projectAccessInputSchema.safeParse(input);
        if (!parsed.success) return { error: await firstIssue(parsed.error, "common.checkForm") };
        const access = await requireProjectAccess(parsed.data.projectId, user.id, "members.manage");
        await projectService.setProjectAccess({
            ...parsed.data,
            granter: {
                id: user.id,
                capabilities: access.capabilities,
                environmentIds: access.environmentIds
            }
        });
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.member.add",
            targetType: "project",
            targetId: parsed.data.projectId,
            metadata: { principal: parsed.data.principal }
        });
        refresh(parsed.data.projectId);
        return {};
    });
}

/** The teams and organizations the person managing access is actually on, so the
 *  picker never offers a roster they cannot see. */
export async function projectAccessCandidatesAction(
    projectId: string
): Promise<Result<{ candidates: projectService.ProjectAccessCandidates }>> {
    return attempt("members.teamsFailed", async () => {
        const user = await requirePermission("deploy.read");
        await requireProjectAccess(projectId, user.id, "members.manage");
        return { candidates: await projectService.listProjectAccessCandidates(user.id) };
    });
}

export async function removeProjectMemberAction(input: {
    projectId: string;
    memberId: string;
}): Promise<Result> {
    return attempt("members.removeFailed", async () => {
        const user = await requirePermission("deploy.manage");
        await requireProjectAccess(input.projectId, user.id, "members.manage");
        await projectService.removeProjectMember(input.projectId, input.memberId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.member.remove",
            targetType: "project",
            targetId: input.projectId
        });
        refresh(input.projectId);
        return {};
    });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function listProjectTokensAction(
    projectId: string
): Promise<Result<{ tokens: projectService.ProjectTokenView[] }>> {
    return attempt("tokens.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        await requireProjectAccess(projectId, user.id, "project.settings");
        return { tokens: await projectService.listProjectTokens(projectId) };
    });
}

export async function createProjectTokenAction(
    input: ProjectTokenInput
): Promise<Result<{ secret: string }>> {
    return attempt("tokens.createFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = projectTokenInputSchema.safeParse(input);
        if (!parsed.success) return { error: await firstIssue(parsed.error, "common.checkForm") };
        const access = await requireProjectAccess(
            parsed.data.projectId,
            user.id,
            "project.settings"
        );
        // A token acts with its minter's access and never more, so one that may
        // change things is only minted by somebody who can change something here.
        if (parsed.data.canManage && !TOKEN_CHANGE_CAPABILITIES.some((can) => accessCan(access, can))) {
            return {
                error: await reply("tokens.beyondYourAccess")
            };
        }
        const created = await projectService.createProjectToken({
            ...parsed.data,
            minterId: user.id
        });
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.token.create",
            targetType: "project",
            targetId: parsed.data.projectId,
            metadata: { prefix: created.prefix }
        });
        return { secret: created.secret };
    });
}

export async function revokeProjectTokenAction(input: {
    projectId: string;
    tokenId: string;
}): Promise<Result> {
    return attempt("tokens.revokeFailed", async () => {
        const user = await requirePermission("deploy.manage");
        await requireProjectAccess(input.projectId, user.id, "project.settings");
        await projectService.revokeProjectToken(input.projectId, input.tokenId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.token.revoke",
            targetType: "project",
            targetId: input.projectId
        });
        return {};
    });
}

export async function deleteProjectTokenAction(input: {
    projectId: string;
    tokenId: string;
}): Promise<Result> {
    return attempt("tokens.deleteFailed", async () => {
        const user = await requirePermission("deploy.manage");
        await requireProjectAccess(input.projectId, user.id, "project.settings");
        await projectService.deleteProjectToken(input.projectId, input.tokenId);
        return {};
    });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function listProjectWebhooksAction(
    projectId: string
): Promise<Result<{ webhooks: projectService.ProjectWebhookView[]; canManage: boolean }>> {
    return attempt("webhooks.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        return {
            webhooks: await projectService.listProjectWebhooks(projectId),
            canManage: accessCan(access, "project.settings")
        };
    });
}

export async function createProjectWebhookAction(input: ProjectWebhookInput): Promise<Result> {
    return attempt("webhooks.addFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const parsed = projectWebhookInputSchema.safeParse(input);
        if (!parsed.success) return { error: await firstIssue(parsed.error, "common.checkForm") };
        await requireProjectAccess(parsed.data.projectId, user.id, "project.settings");
        await projectService.createProjectWebhook(parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.project.webhook.add",
            targetType: "project",
            targetId: parsed.data.projectId
        });
        return {};
    });
}

export async function setProjectWebhookEnabledAction(input: {
    projectId: string;
    id: string;
    enabled: boolean;
}): Promise<Result> {
    return attempt("webhooks.updateFailed", async () => {
        const user = await requirePermission("deploy.manage");
        await requireProjectAccess(input.projectId, user.id, "project.settings");
        await projectService.setProjectWebhookEnabled(input.projectId, input.id, input.enabled);
        return {};
    });
}

export async function deleteProjectWebhookAction(input: {
    projectId: string;
    id: string;
}): Promise<Result> {
    return attempt("webhooks.removeFailed", async () => {
        const user = await requirePermission("deploy.manage");
        await requireProjectAccess(input.projectId, user.id, "project.settings");
        await projectService.deleteProjectWebhook(input.projectId, input.id);
        return {};
    });
}

export async function testProjectWebhookAction(input: {
    projectId: string;
    id: string;
}): Promise<Result> {
    return attempt("webhooks.unreachable", async () => {
        const user = await requirePermission("deploy.manage");
        await requireProjectAccess(input.projectId, user.id, "project.settings");
        return projectService.testProjectWebhook(input.projectId, input.id);
    });
}

// ---------------------------------------------------------------------------
// Usage and template
// ---------------------------------------------------------------------------

export async function projectUsageAction(
    projectId: string
): Promise<Result<{ usage: projectService.ProjectUsage }>> {
    return attempt("usage.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        await requireProjectAccess(projectId, user.id, "project.read");
        return { usage: await projectService.getProjectUsage(projectId) };
    });
}

/**
 * What the project has used so far this month, and what that comes to at the
 * instance's prices when it has any - the project's own line of the statement
 * Management > Billing draws for every project.
 */
export async function projectMonthUsageAction(
    projectId: string
): Promise<Result<{ month: StatementView }>> {
    return attempt("usage.monthFailed", async () => {
        const user = await requirePermission("deploy.read");
        await requireProjectAccess(projectId, user.id, "project.read");
        return { month: await readMonthToDate({ kind: "project", projectId }) };
    });
}

export async function exportProjectTemplateAction(
    projectId: string
): Promise<Result<{ template: string }>> {
    return attempt("settings.templateFailed", async () => {
        const user = await requirePermission("deploy.read");
        await requireProjectAccess(projectId, user.id, "project.settings");
        const template = await projectService.exportProjectTemplate(projectId);
        return { template: JSON.stringify(template, null, 4) };
    });
}

// ---------------------------------------------------------------------------
// Staged changes
// ---------------------------------------------------------------------------

export async function listStagedChangesAction(
    projectId: string
): Promise<Result<{ changes: staged.StagedChangeView[] }>> {
    return attempt("staged.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        const changes = await staged.listProjectStagedChanges(projectId);
        return {
            changes: changes.filter((change) => accessInEnvironment(access, change.environmentId))
        };
    });
}

/**
 * Queue a service removal, or carry it out at once when the project has turned
 * staging off. The answer says which happened, so the caller can close the panel
 * on an immediate delete and leave it open on a staged one.
 */
export async function stageServiceDeleteAction(input: {
    applicationId: string;
}): Promise<Result<{ staged: boolean }>> {
    return attempt("staged.removeServiceFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const access = await requireApplicationAccess(
            input.applicationId,
            user.id,
            "service.delete"
        );
        const app = await deployService.getApplicationSummary(input.applicationId, access.ownerId);
        if (!app) return { error: await reply("common.serviceNotFound") };

        if (!(await staged.projectStagesChanges(access.projectId))) {
            await deployService.deleteApplication(input.applicationId, access.ownerId);
            await recordDeployAudit({
                actorId: user.id,
                orgId: access.orgId ?? undefined,
                action: "deploy.app.delete",
                targetType: "application",
                targetId: input.applicationId
            });
            refresh(access.projectId);
            return { staged: false };
        }

        await staged.stageChange({
            environmentId: access.environmentId,
            kind: "service.delete",
            targetType: "application",
            targetId: input.applicationId,
            targetName: app.name,
            createdById: user.id
        });
        refresh(access.projectId);
        return { staged: true };
    });
}

export async function stageDatabaseDeleteAction(input: {
    databaseId: string;
}): Promise<Result<{ staged: boolean }>> {
    return attempt("staged.removeDatabaseFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const database = await deployService.getDatabaseSummary(input.databaseId);
        if (!database) return { error: await reply("common.databaseNotFound") };
        const access = await requireEnvironmentAccess(
            database.environmentId,
            user.id,
            "databases.manage"
        );

        if (!(await staged.projectStagesChanges(access.projectId))) {
            const { deleteDatabase } = await import("@/lib/database-service");
            await deleteDatabase(input.databaseId, access.ownerId);
            await recordDeployAudit({
                actorId: user.id,
                orgId: access.orgId ?? undefined,
                action: "deploy.db.delete",
                targetType: "database",
                targetId: input.databaseId
            });
            refresh(access.projectId);
            return { staged: false };
        }

        await staged.stageChange({
            environmentId: database.environmentId,
            kind: "database.delete",
            targetType: "database",
            targetId: input.databaseId,
            targetName: database.name,
            createdById: user.id
        });
        refresh(access.projectId);
        return { staged: true };
    });
}

export async function stageVolumeDeleteAction(input: {
    volumeId: string;
    wipe: boolean;
}): Promise<Result<{ staged: boolean }>> {
    return attempt("volumes.removeFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const volume = await volumeFor(input.volumeId, user.id);
        if (!volume.applicationId) return { error: await reply("volumes.detached") };
        const access = await requireApplicationAccess(
            volume.applicationId,
            user.id,
            "volumes.manage"
        );

        if (!(await staged.projectStagesChanges(access.projectId))) {
            await deleteVolume(input.volumeId, access.ownerId, { wipe: input.wipe });
            void deployService
                .redeployForEnvScope("application", volume.applicationId, access.ownerId, user.id)
                .catch(() => undefined);
            refresh(access.projectId);
            return { staged: false };
        }

        await staged.stageChange({
            environmentId: access.environmentId,
            kind: "volume.delete",
            targetType: "volume",
            targetId: input.volumeId,
            targetName: volume.name,
            payload: { wipe: input.wipe },
            createdById: user.id
        });
        refresh(access.projectId);
        return { staged: true };
    });
}

export async function discardStagedChangeAction(input: {
    projectId: string;
    id: string;
}): Promise<Result> {
    return attempt("staged.discardFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const access = await requireProjectAccess(input.projectId, user.id, "deploy.run");
        const change = (await staged.listProjectStagedChanges(input.projectId)).find(
            (entry) => entry.id === input.id
        );
        // A change staged in an environment this entry does not reach is not one
        // it may discard, and saying so would name it.
        if (!change || !accessInEnvironment(access, change.environmentId))
            return { error: await reply("staged.gone") };
        await staged.discardStagedChange(input.id, change.environmentId);
        refresh(input.projectId);
        return {};
    });
}

export async function discardAllStagedChangesAction(input: {
    projectId: string;
    environmentId: string;
}): Promise<Result> {
    return attempt("staged.discardAllFailed", async () => {
        const user = await requirePermission("deploy.manage");
        // Through the environment, not the project: the capability is only half
        // the question once an entry names environments, and a changeset staged
        // in production is not something an entry limited to development discards.
        const access = await requireEnvironmentAccess(input.environmentId, user.id, "deploy.run");
        if (access.projectId !== input.projectId)
            return { error: await reply("environment.elsewhere") };
        await staged.discardAllStagedChanges(input.environmentId);
        refresh(input.projectId);
        return {};
    });
}

/**
 * Deploy the changeset. Reports what could not be applied rather than throwing,
 * because a partly-applied run is the normal shape of a failure here: what
 * succeeded is already gone, and what did not is still staged to retry.
 */
export async function applyStagedChangesAction(input: {
    projectId: string;
    environmentId: string;
}): Promise<Result<{ applied: number; failures: { targetName: string; error: string }[] }>> {
    return attempt("staged.deployFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const access = await requireEnvironmentAccess(input.environmentId, user.id, "deploy.run");
        if (access.projectId !== input.projectId)
            return { error: await reply("environment.elsewhere") };
        const result = await staged.applyStagedChanges(input.environmentId, access.ownerId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.changeset.apply",
            targetType: "environment",
            targetId: input.environmentId,
            metadata: { applied: result.applied, failed: result.failures.length }
        });
        refresh(input.projectId);
        return result;
    });
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

async function volumeFor(volumeId: string, userId: string): Promise<VolumeDetail> {
    // The volume is read as its own project's owner, after the caller's standing
    // on that project has been checked - the same two-step every action here uses.
    const summary = await deployService.getVolumeOwner(volumeId);
    if (!summary) throw new Error(await reply("volumes.notFound"));
    if (summary.applicationId) {
        await requireApplicationAccess(summary.applicationId, userId, "project.read");
    } else if (summary.ownerId !== userId) {
        throw new Error(await reply("volumes.notFound"));
    }
    return getVolume(volumeId, summary.ownerId);
}

/**
 * Everything about a volume that is already known, which is everything except
 * how full it is. Kept apart from the measurement below deliberately: reading
 * the row is instant, while measuring means reaching a container on another
 * host, and bundling them made the panel show nothing until the slow half
 * finished.
 */
export async function volumeDetailAction(
    volumeId: string
): Promise<Result<{ volume: VolumeDetail; canManage: boolean }>> {
    return attempt("volumes.loadFailed", async () => {
        const user = await requirePermission("deploy.read");
        const volume = await volumeFor(volumeId, user.id);
        const access = volume.applicationId
            ? await requireApplicationAccess(volume.applicationId, user.id, "project.read")
            : null;
        return { volume, canManage: access ? accessCan(access, "volumes.manage") : true };
    });
}

/** How full a volume is, measured from inside the service that mounts it. Null
 *  when it cannot be measured now (nothing running, no `du`, or too slow). */
export async function volumeUsageAction(
    volumeId: string
): Promise<Result<{ usedBytes: number | null }>> {
    return attempt("volumes.measureFailed", async () => {
        const user = await requirePermission("deploy.read");
        await volumeFor(volumeId, user.id);
        const owner = await deployService.getVolumeOwner(volumeId);
        return { usedBytes: await measureVolumeUsage(volumeId, owner?.ownerId ?? user.id) };
    });
}

export async function wipeVolumeAction(volumeId: string): Promise<Result> {
    return attempt("volumes.wipeFailed", async () => {
        const user = await requirePermission("deploy.manage");
        const volume = await volumeFor(volumeId, user.id);
        if (!volume.applicationId) return { error: await reply("volumes.detached") };
        const access = await requireApplicationAccess(
            volume.applicationId,
            user.id,
            "volumes.manage"
        );
        await wipeVolume(volumeId, access.ownerId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.volume.wipe",
            targetType: "volume",
            targetId: volumeId
        });
        refresh(access.projectId);
        return {};
    });
}
