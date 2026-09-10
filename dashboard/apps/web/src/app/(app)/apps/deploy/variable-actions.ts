"use server";

/**
 * The variables editor's actions: save a batch of edits, redeploy on request,
 * and say what each reference variable points at.
 *
 * Saving no longer redeploys by itself. Somebody changing five variables wants
 * one redeploy, not five, and somebody changing one before a migration lands
 * wants none yet - so the editor offers Save and Save and redeploy, and a
 * redeploy is asked for with the right to deploy, not the right to edit.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import * as activity from "@/lib/activity/activity";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { redeployForEnvScope } from "@/lib/deploy-service";
import { requireEnvScopeAccess } from "@/lib/deploy-project-access";
import { variableChangesSchema } from "@/lib/deploy/variable-changes";
import { variableLinks, type VariableLink } from "@/lib/deploy/variable-links";
import { deleteEnvVar, envVarScope, setEnvVar, setEnvVarSecrecy, type EnvScope } from "@/lib/env-var-service";

const DEPLOY_PATH = "/apps/deploy";

const scopeSchema = z.object({
    scope: z.enum(["application", "environment"]),
    scopeId: z.string().trim().min(1).max(100)
});

async function audit(
    actorId: string,
    orgId: string | null,
    scope: EnvScope,
    scopeId: string,
    action: string,
    metadata: Record<string, unknown>
): Promise<void> {
    // The name and whether it is a secret, never the value (see recordVariableEvent).
    await recordDeployAudit({
        actorId,
        orgId: orgId ?? undefined,
        action,
        targetType: scope === "application" ? "application" : "environment",
        targetId: scopeId,
        metadata
    });
}

/**
 * Apply the difference the editor computed - removals, secrecy flips, then the
 * values typed - and redeploy only when asked. Every id is checked to belong to
 * the scope being edited, so a batch cannot reach a variable somewhere else.
 */
export async function saveEnvVarChangesAction(
    input: unknown
): Promise<{ error?: string; saved?: number; redeployed?: boolean }> {
    const user = await requirePermission("deploy.manage");
    const parsed = variableChangesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the variables" };
    const { scope, scopeId, set, secrecy, remove, redeploy } = parsed.data;
    if (set.length + secrecy.length + remove.length === 0 && !redeploy) return { saved: 0 };

    try {
        const access = await requireEnvScopeAccess(scope, scopeId, user.id, "variables.write");
        // Asked before anything is written, so a refusal leaves nothing half-done.
        if (redeploy) await requireEnvScopeAccess(scope, scopeId, user.id, "deploy.run");

        const keys = new Map<string, string>();
        for (const id of [...remove, ...secrecy.map((item) => item.id)]) {
            const located = await envVarScope(id);
            if (!located || located.scope !== scope || located.scopeId !== scopeId) {
                return { error: "One of those variables no longer exists - reload and try again" };
            }
            keys.set(id, located.key);
        }

        for (const id of remove) {
            await deleteEnvVar(id, access.ownerId);
            await audit(user.id, access.orgId, scope, scopeId, "deploy.variable.remove", { key: keys.get(id) });
            if (scope === "application") {
                await activity.record({ subjectType: "app", subjectId: scopeId, userId: user.id, action: "variable-removed" });
            }
        }
        for (const item of secrecy) {
            await setEnvVarSecrecy(item.id, access.ownerId, item.isSecret);
            await audit(user.id, access.orgId, scope, scopeId, "deploy.variable.set", {
                key: keys.get(item.id),
                secret: item.isSecret
            });
            if (scope === "application") {
                await activity.record({
                    subjectType: "app",
                    subjectId: scopeId,
                    userId: user.id,
                    action: "variable",
                    toValue: keys.get(item.id)
                });
            }
        }
        for (const item of set) {
            await setEnvVar(scope, scopeId, access.ownerId, item);
            await audit(user.id, access.orgId, scope, scopeId, "deploy.variable.set", {
                key: item.key,
                secret: item.isSecret
            });
            if (scope === "application") {
                await activity.record({
                    subjectType: "app",
                    subjectId: scopeId,
                    userId: user.id,
                    action: "variable",
                    toValue: item.key
                });
            }
        }

        if (redeploy) void redeployForEnvScope(scope, scopeId, access.ownerId).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return { saved: set.length + secrecy.length + remove.length, redeployed: redeploy };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the variables" };
    }
}

/** Redeploy what a scope's variables reach, after changes were saved without one. */
export async function redeployEnvScopeAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return { error: "Nothing to redeploy" };
    try {
        const access = await requireEnvScopeAccess(parsed.data.scope, parsed.data.scopeId, user.id, "deploy.run");
        void redeployForEnvScope(parsed.data.scope, parsed.data.scopeId, access.ownerId).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the redeploy" };
    }
}

/** What each reference variable in a scope points at, by variable id. */
export async function variableLinksAction(input: unknown): Promise<Record<string, VariableLink[]>> {
    const user = await requirePermission("deploy.read");
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return {};
    try {
        await requireEnvScopeAccess(parsed.data.scope, parsed.data.scopeId, user.id, "variables.read");
        return await variableLinks(parsed.data.scope, parsed.data.scopeId);
    } catch {
        return {};
    }
}
