"use server";

/**
 * The variables editor's actions: save a batch of edits, redeploy on request,
 * say what each reference variable points at, hand over every value at once
 * for the raw editor, and promote a service's variable to a shared one.
 *
 * Saving no longer redeploys by itself. Somebody changing five variables wants
 * one redeploy, not five, and somebody changing one before a migration lands
 * wants none yet - so the editor offers Save and Save and redeploy, and a
 * redeploy is asked for with the right to deploy, not the right to edit.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { firstIssue, reply } from "./reply";
import { requirePermission } from "@/lib/session";
import * as activity from "@/lib/activity/activity";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { redeployForEnvScope } from "@/lib/deploy-service";
import { requireEnvScopeAccess } from "@/lib/deploy-project-access";
import { SET_TWICE, variableChangesSchema } from "@/lib/deploy/variable-changes";
import { variableLinks, type VariableLink } from "@/lib/deploy/variable-links";
import {
    deleteEnvVar,
    envVarScope,
    listEnvVars,
    revealEnvVar,
    setEnvVar,
    setEnvVarSecrecy,
    type EnvScope
} from "@/lib/env-var-service";
import { getTranslations } from "@/lib/i18n/request";

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
    if (!parsed.success) {
        const twice = SET_TWICE.exec(parsed.error.issues[0]?.message ?? "");
        if (twice?.[1]) return { error: (await getTranslations("deployServer"))("variables.setTwice", { key: twice[1] }) };
        return { error: await firstIssue(parsed.error, "variables.check") };
    }
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
                return { error: await reply("variables.oneGone") };
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

        if (redeploy) void redeployForEnvScope(scope, scopeId, access.ownerId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return { saved: set.length + secrecy.length + remove.length, redeployed: redeploy };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await reply("variables.saveFailed") };
    }
}

/** Redeploy what a scope's variables reach, after changes were saved without one. */
export async function redeployEnvScopeAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("variables.nothingToRedeploy") };
    try {
        const access = await requireEnvScopeAccess(parsed.data.scope, parsed.data.scopeId, user.id, "deploy.run");
        void redeployForEnvScope(parsed.data.scope, parsed.data.scopeId, access.ownerId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await reply("variables.redeployFailed") };
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

/**
 * Every value of a scope at once, secrets included, for the raw editor - to
 * somebody who may read the variables, as revealing one does. Which secrets
 * were handed over is written to the audit once, by name.
 */
export async function revealEnvScopeAction(
    input: unknown
): Promise<{ values?: Record<string, string>; error?: string }> {
    const user = await requirePermission("deploy.read");
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("variables.revealAllFailed") };
    const { scope, scopeId } = parsed.data;
    try {
        const access = await requireEnvScopeAccess(scope, scopeId, user.id, "variables.read");
        const rows = await listEnvVars(scope, scopeId, access.ownerId);
        const values: Record<string, string> = {};
        const secrets: string[] = [];
        for (const row of rows) {
            if (!row.isSecret) {
                values[row.id] = row.value ?? "";
                continue;
            }
            values[row.id] = (await revealEnvVar(row.id, access.ownerId)) ?? "";
            secrets.push(row.key);
        }
        if (secrets.length > 0) {
            await audit(user.id, access.orgId, scope, scopeId, "deploy.variable.reveal", { keys: secrets });
        }
        return { values };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await reply("variables.revealAllFailed") };
    }
}

/** A value that already reads a shared variable, which promoting would only
 *  point at itself. */
const SHARED_REFERENCE = /^\$\{\{\s*shared\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;

/**
 * Promote a service's variable to a shared one, as Railway's menu does: the
 * value moves to the environment's shared variables, keeping whether it is a
 * secret, and the service's variable becomes `${{shared.KEY}}`, so it reads
 * the same value and every other service can too. Refused, before anything is
 * written, when the environment already shares a variable by that name.
 */
export async function promoteEnvVarAction(input: unknown): Promise<{ key?: string; error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = z.object({ id: z.string().trim().min(1).max(100) }).safeParse(input);
    if (!parsed.success) return { error: await reply("variables.gone") };
    try {
        const located = await envVarScope(parsed.data.id);
        if (!located) return { error: await reply("variables.gone") };
        if (located.scope !== "application") return { error: await reply("variables.notPromotable") };
        const service = await requireEnvScopeAccess("application", located.scopeId, user.id, "variables.write");
        const shared = await requireEnvScopeAccess("environment", service.environmentId, user.id, "variables.write");
        const row = (await listEnvVars("application", located.scopeId, service.ownerId)).find(
            (one) => one.id === parsed.data.id
        );
        if (!row) return { error: await reply("variables.gone") };
        const value = (await revealEnvVar(row.id, service.ownerId)) ?? "";
        if (SHARED_REFERENCE.test(value.trim())) return { error: await reply("variables.notPromotable") };
        const taken = (await listEnvVars("environment", service.environmentId, shared.ownerId)).some(
            (one) => one.key === row.key
        );
        if (taken) return { error: await reply("variables.alreadyShared", { key: row.key }) };

        await setEnvVar("environment", service.environmentId, shared.ownerId, {
            key: row.key,
            value,
            isSecret: row.isSecret
        });
        await audit(user.id, shared.orgId, "environment", service.environmentId, "deploy.variable.set", {
            key: row.key,
            secret: row.isSecret,
            promotedFrom: located.scopeId
        });
        await setEnvVar("application", located.scopeId, service.ownerId, {
            key: row.key,
            value: `\${{shared.${row.key}}}`,
            isSecret: false
        });
        await audit(user.id, service.orgId, "application", located.scopeId, "deploy.variable.set", {
            key: row.key,
            secret: false,
            promotedTo: service.environmentId
        });
        revalidatePath(DEPLOY_PATH);
        return { key: row.key };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await reply("variables.promoteFailed") };
    }
}
