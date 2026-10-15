"use server";

/**
 * A project's automations: the actions behind its Automations settings.
 *
 * Reading the rules and their runs asks only to see the project. Changing one -
 * or pressing Run - is deploying its services on a schedule nobody watches, so
 * it asks for the right to deploy here, a console when the rule runs commands,
 * and reach into the environment of every service it names. The service checks
 * the same reach again before every unattended run, as whoever saved the rule.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { firstIssue, reply } from "./reply";
import type { NamespaceKey } from "@/lib/i18n/types";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as automations from "@/lib/deploy/automations";
import { requirePermission, userHasManage } from "@/lib/session";
import { accessCan, requireProjectAccess, type ProjectAccess } from "@/lib/deploy-project-access";

const idSchema = z.string().uuid();

type Failure = { error: string };

const ERROR_KEYS = {
    notFound: "automations.notFound",
    foreignService: "automations.foreignService",
    limit: "automations.limit",
    reach: "automations.reach"
} as const satisfies Record<automations.AutomationErrorCode, NamespaceKey<"deployServer">>;

async function failure(caught: unknown, fallback: NamespaceKey<"deployServer">): Promise<Failure> {
    if (caught instanceof automations.AutomationError) {
        return {
            error: await reply(ERROR_KEYS[caught.code], { limit: core.DEPLOY_AUTOMATION_LIMIT })
        };
    }
    // Anything else names internals; it is logged, not shown.
    console.error("polaris: a project automation action failed:", caught);
    return { error: await reply(fallback) };
}

/** The reader's access to a project, for changing its automations. */
async function editorAccess(projectId: string, userId: string): Promise<ProjectAccess> {
    return requireProjectAccess(projectId, userId, "deploy.run");
}

function audit(
    access: ProjectAccess,
    actorId: string,
    action: string,
    automationId: string
): Promise<void> {
    return recordDeployAudit({
        actorId,
        action,
        orgId: access.orgId ?? undefined,
        targetType: "project",
        targetId: access.projectId,
        metadata: { automationId }
    });
}

export interface AutomationsLoad {
    readonly automations: automations.DeployAutomationView[];
    readonly services: automations.AutomationServiceOption[];
    /** Whether the reader may change rules, and run commands in them. */
    readonly canEdit: boolean;
    readonly canCommand: boolean;
}

export async function listAutomationsAction(
    projectId: string
): Promise<{ error?: string; data?: AutomationsLoad }> {
    const user = await requirePermission("deploy.read");
    try {
        if (!idSchema.safeParse(projectId).success)
            throw new automations.AutomationError("notFound");
        const access = await requireProjectAccess(projectId, user.id, "project.read");
        const canEdit =
            accessCan(access, "deploy.run") && (await userHasManage(user, "deploy.manage"));
        const [rules, services] = await Promise.all([
            automations.listAutomations(projectId),
            automations.automationServices(projectId, access.environmentIds)
        ]);
        return {
            data: {
                automations: rules,
                services,
                canEdit,
                canCommand: canEdit && accessCan(access, "console.use")
            }
        };
    } catch (caught) {
        return failure(caught, "automations.loadFailed");
    }
}

export async function saveAutomationAction(input: unknown): Promise<{
    error?: string;
    automation?: automations.DeployAutomationView;
    webhookUrl?: string | null;
}> {
    const user = await requirePermission("deploy.manage");
    const parsed = core.deployAutomationInputSchema.safeParse(input);
    if (!parsed.success)
        return { error: await firstIssue(parsed.error, "automations.checkDetails") };
    try {
        const access = await editorAccess(parsed.data.projectId, user.id);
        if (automations.needsConsole(parsed.data.actions) && !accessCan(access, "console.use"))
            throw new automations.AutomationError("reach");
        const saved = await automations.saveAutomation(parsed.data, user.id, access.environmentIds);
        await audit(
            access,
            user.id,
            parsed.data.id ? "deploy.automation.update" : "deploy.automation.create",
            saved.automation.id
        );
        return saved;
    } catch (caught) {
        return failure(caught, "automations.saveFailed");
    }
}

const targetSchema = z.object({ projectId: idSchema, automationId: idSchema });

export async function setAutomationEnabledAction(
    input: unknown
): Promise<{ error?: string; automation?: automations.DeployAutomationView }> {
    const user = await requirePermission("deploy.manage");
    const parsed = targetSchema.extend({ enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: await reply("automations.checkDetails") };
    try {
        const access = await editorAccess(parsed.data.projectId, user.id);
        const automation = await automations.setAutomationEnabled(
            access.projectId,
            parsed.data.automationId,
            parsed.data.enabled
        );
        await audit(
            access,
            user.id,
            parsed.data.enabled ? "deploy.automation.enable" : "deploy.automation.disable",
            automation.id
        );
        return { automation };
    } catch (caught) {
        return failure(caught, "automations.saveFailed");
    }
}

export async function rotateAutomationWebhookAction(
    input: unknown
): Promise<{ error?: string; webhookUrl?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("automations.checkDetails") };
    try {
        const access = await editorAccess(parsed.data.projectId, user.id);
        const webhookUrl = await automations.rotateAutomationWebhook(
            access.projectId,
            parsed.data.automationId
        );
        await audit(access, user.id, "deploy.automation.rotate", parsed.data.automationId);
        return { webhookUrl };
    } catch (caught) {
        return failure(caught, "automations.rotateFailed");
    }
}

export async function deleteAutomationAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("automations.checkDetails") };
    try {
        const access = await editorAccess(parsed.data.projectId, user.id);
        await automations.deleteAutomation(access.projectId, parsed.data.automationId);
        await audit(access, user.id, "deploy.automation.delete", parsed.data.automationId);
        return {};
    } catch (caught) {
        return failure(caught, "automations.removeFailed");
    }
}

export async function runAutomationAction(
    input: unknown
): Promise<{ error?: string; runId?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("automations.checkDetails") };
    try {
        const access = await editorAccess(parsed.data.projectId, user.id);
        const runId = await automations.runAutomationNow(access, parsed.data.automationId, user.id);
        await audit(access, user.id, "deploy.automation.run", parsed.data.automationId);
        return { runId };
    } catch (caught) {
        return failure(caught, "automations.runFailed");
    }
}

export async function listAutomationRunsAction(
    input: unknown
): Promise<{ error?: string; runs?: automations.DeployAutomationRunView[] }> {
    const user = await requirePermission("deploy.read");
    const parsed = targetSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("automations.checkDetails") };
    try {
        await requireProjectAccess(parsed.data.projectId, user.id, "project.read");
        return {
            runs: await automations.listAutomationRuns(
                parsed.data.projectId,
                parsed.data.automationId
            )
        };
    } catch (caught) {
        return failure(caught, "automations.runsFailed");
    }
}
