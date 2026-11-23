"use server";

/**
 * The variables editor's actions: save a batch of edits, redeploy on request,
 * say what each reference variable points at, hand over every value at once
 * for the raw editor, promote a service's variable to a shared one, seal one
 * for good, and give one a generator.
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
import { environmentReferrers } from "@/lib/deploy/variable-referrers";
import { parseGenerator } from "@/lib/deploy/variable-generator";
import {
    deleteEnvVar,
    envVarScope,
    listEnvVars,
    promoteEnvVar,
    revealEnvVar,
    sealEnvVar,
    sealedValue,
    setEnvVar,
    setEnvVarGenerator,
    setEnvVarSecrecy,
    type EnvScope
} from "@/lib/env-var-service";
import { getTranslations } from "@/lib/i18n/request";
import * as groups from "@/lib/deploy/variable-groups";
import { variableScopeSchema } from "@/lib/deploy/variable-groups";

const DEPLOY_PATH = "/apps/deploy";

const scopeSchema = variableScopeSchema;

/** The services that read `keys` of a service (all of its keys when none are
 *  given). A failure to work it out redeploys the service alone, as before. */
async function readersOf(
    serviceId: string,
    ownerId: string,
    keys: readonly string[] | undefined
): Promise<string[]> {
    try {
        const wanted =
            keys ?? (await listEnvVars("application", serviceId, ownerId)).map((row) => row.key);
        return await environmentReferrers(serviceId, wanted);
    } catch {
        return [];
    }
}

/** Start redeploying what a scope's variables reach: a service, an environment's
 *  services, or every deployed service linking a group that the actor may deploy.
 *  Answers how many of a group's services were skipped for lack of that right.
 *
 *  A service's redeploy also reaches every service in its environment that reads
 *  one of `keys` through a reference (`${{api.API_KEY}}`), since a rotated value
 *  means nothing to them until they are deployed again; without `keys`, any of
 *  its variables counts. Answers how many such services were added. */
async function redeployScope(
    actor: { id: string; isAdmin: boolean },
    scope: EnvScope,
    scopeId: string,
    ownerId: string,
    keys?: readonly string[]
): Promise<{ skipped: number; referrers: number }> {
    if (scope === "group") {
        const { skipped } = await groups.redeployLinked(
            actor,
            scopeId,
            (applicationId, appOwnerId) =>
                redeployForEnvScope("application", applicationId, appOwnerId, actor.id)
        );
        return { skipped, referrers: 0 };
    }
    const readers = scope === "application" ? await readersOf(scopeId, ownerId, keys) : [];
    void (async () => {
        await redeployForEnvScope(scope, scopeId, ownerId, actor.id);
        // Same environment, so the same project and the same right to deploy.
        for (const id of readers)
            await redeployForEnvScope("application", id, ownerId, actor.id, { rotation: scopeId });
    })().catch(() => undefined);
    return { skipped: 0, referrers: readers.length };
}

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
        targetType: groups.variableTargetType(scope),
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
): Promise<{
    error?: string;
    saved?: number;
    redeployed?: boolean;
    skipped?: number;
    referrers?: number;
}> {
    const user = await requirePermission("deploy.manage");
    const parsed = variableChangesSchema.safeParse(input);
    if (!parsed.success) {
        const twice = SET_TWICE.exec(parsed.error.issues[0]?.message ?? "");
        if (twice?.[1])
            return {
                error: (await getTranslations("deployServer"))("variables.setTwice", {
                    key: twice[1]
                })
            };
        return { error: await firstIssue(parsed.error, "variables.check") };
    }
    const { scope, scopeId, set, secrecy, remove, redeploy } = parsed.data;
    if (set.length + secrecy.length + remove.length === 0 && !redeploy) return { saved: 0 };

    try {
        const access = await groups.requireVariableScopeAccess(
            scope,
            scopeId,
            user,
            "variables.write"
        );
        // Asked before anything is written, so a refusal leaves nothing half-done.
        if (redeploy) await groups.requireVariableScopeAccess(scope, scopeId, user, "deploy.run");

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
            await audit(user.id, access.orgId, scope, scopeId, "deploy.variable.remove", {
                key: keys.get(id)
            });
            if (scope === "application") {
                await activity.record({
                    subjectType: "app",
                    subjectId: scopeId,
                    userId: user.id,
                    action: "variable-removed"
                });
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

        if (scope === "group") await groups.touchGroup(scopeId);
        const changedKeys = [...set.map((item) => item.key), ...keys.values()];
        const { skipped, referrers } = redeploy
            ? await redeployScope(user, scope, scopeId, access.ownerId, changedKeys).catch(() => ({
                  skipped: 0,
                  referrers: 0
              }))
            : { skipped: 0, referrers: 0 };
        revalidatePath(DEPLOY_PATH);
        return {
            saved: set.length + secrecy.length + remove.length,
            redeployed: redeploy,
            ...(skipped > 0 ? { skipped } : {}),
            ...(referrers > 0 ? { referrers } : {})
        };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : await reply("variables.saveFailed")
        };
    }
}

/** Redeploy what a scope's variables reach, after changes were saved without one. */
export async function redeployEnvScopeAction(
    input: unknown
): Promise<{ error?: string; skipped?: number; referrers?: number }> {
    const user = await requirePermission("deploy.manage");
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("variables.nothingToRedeploy") };
    try {
        const access = await groups.requireVariableScopeAccess(
            parsed.data.scope,
            parsed.data.scopeId,
            user,
            "deploy.run"
        );
        const { skipped, referrers } = await redeployScope(
            user,
            parsed.data.scope,
            parsed.data.scopeId,
            access.ownerId
        );
        revalidatePath(DEPLOY_PATH);
        return {
            ...(skipped > 0 ? { skipped } : {}),
            ...(referrers > 0 ? { referrers } : {})
        };
    } catch (caught) {
        return {
            error:
                caught instanceof Error ? caught.message : await reply("variables.redeployFailed")
        };
    }
}

/** What each reference variable in a scope points at, by variable id. */
export async function variableLinksAction(input: unknown): Promise<Record<string, VariableLink[]>> {
    const user = await requirePermission("deploy.read");
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return {};
    // A group's references resolve against each service that links it, so
    // there is nothing to point at from the group itself.
    if (parsed.data.scope === "group") return {};
    try {
        await requireEnvScopeAccess(
            parsed.data.scope,
            parsed.data.scopeId,
            user.id,
            "variables.read"
        );
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
        const access = await groups.requireVariableScopeAccess(
            scope,
            scopeId,
            user,
            "variables.read",
            { reveal: true }
        );
        const rows = await listEnvVars(scope, scopeId, access.ownerId);
        const values: Record<string, string> = {};
        const secrets: string[] = [];
        for (const row of rows) {
            // Never read back: the raw editor shows it empty, which saves as untouched.
            if (row.sealed) continue;
            if (!row.isSecret) {
                values[row.id] = row.value ?? "";
                continue;
            }
            values[row.id] = (await revealEnvVar(row.id, access.ownerId)) ?? "";
            secrets.push(row.key);
        }
        if (secrets.length > 0) {
            await audit(user.id, access.orgId, scope, scopeId, "deploy.variable.reveal", {
                keys: secrets
            });
        }
        return { values };
    } catch (caught) {
        return {
            error:
                caught instanceof Error ? caught.message : await reply("variables.revealAllFailed")
        };
    }
}

/** A value that already reads a shared variable, which promoting would only
 *  point at itself. */
const SHARED_REFERENCE = /^\$\{\{\s*shared\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;

/**
 * Promote a service's variable to a shared one, as Railway's menu does: the
 * value moves to the environment's shared variables, keeping whether it is a
 * secret, and the service's variable becomes `${{shared.KEY}}`, so it reads
 * the same value and every other service can too. Both are written in one
 * transaction, and nothing is when the environment already shares a variable
 * by that name.
 */
export async function promoteEnvVarAction(
    input: unknown
): Promise<{ key?: string; error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = z.object({ id: z.string().trim().min(1).max(100) }).safeParse(input);
    if (!parsed.success) return { error: await reply("variables.gone") };
    try {
        const located = await envVarScope(parsed.data.id);
        if (!located) return { error: await reply("variables.gone") };
        if (located.scope !== "application")
            return { error: await reply("variables.notPromotable") };
        const service = await requireEnvScopeAccess(
            "application",
            located.scopeId,
            user.id,
            "variables.write"
        );
        const shared = await requireEnvScopeAccess(
            "environment",
            service.environmentId,
            user.id,
            "variables.write"
        );
        const row = (await listEnvVars("application", located.scopeId, service.ownerId)).find(
            (one) => one.id === parsed.data.id
        );
        if (!row) return { error: await reply("variables.gone") };
        // Opened only to be sealed again where it moves to; never answered.
        const value = (await sealedValue(row.id, service.ownerId)) ?? "";
        if (SHARED_REFERENCE.test(value.trim()))
            return { error: await reply("variables.notPromotable") };
        const promoted = await promoteEnvVar({
            serviceId: located.scopeId,
            serviceOwnerId: service.ownerId,
            environmentId: service.environmentId,
            environmentOwnerId: shared.ownerId,
            key: row.key,
            value,
            isSecret: row.isSecret,
            sealed: Boolean(row.sealed),
            generator: row.generator ?? null
        });
        if (!promoted) return { error: await reply("variables.alreadyShared", { key: row.key }) };

        await audit(
            user.id,
            shared.orgId,
            "environment",
            service.environmentId,
            "deploy.variable.set",
            {
                key: row.key,
                secret: row.isSecret,
                promotedFrom: located.scopeId
            }
        );
        await audit(user.id, service.orgId, "application", located.scopeId, "deploy.variable.set", {
            key: row.key,
            secret: false,
            promotedTo: service.environmentId
        });
        revalidatePath(DEPLOY_PATH);
        return { key: row.key };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : await reply("variables.promoteFailed")
        };
    }
}
const variableIdSchema = z.object({ id: z.string().trim().min(1).max(100) });

/** Where a variable lives, checked against the actor's right to edit it there. */
async function writableVariable(
    user: { id: string; isAdmin: boolean; },
    id: string
): Promise<
    | { scope: EnvScope; scopeId: string; key: string; ownerId: string; orgId: string | null; }
    | null
> {
    const located = await envVarScope(id);
    if (!located) return null;
    const access = await groups.requireVariableScopeAccess(
        located.scope,
        located.scopeId,
        user,
        "variables.write"
    );
    return { ...located, ownerId: access.ownerId, orgId: access.orgId };
}

/**
 * Seal a variable, for good: from here on it can be replaced but never read -
 * not from this screen, the raw editor or the API - while every deploy still
 * gets it and references still resolve it.
 */
export async function sealEnvVarAction(input: unknown): Promise<{ error?: string; }> {
    const user = await requirePermission("deploy.manage");
    const parsed = variableIdSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("variables.gone") };
    try {
        const variable = await writableVariable(user, parsed.data.id);
        if (!variable) return { error: await reply("variables.gone") };
        if (await sealEnvVar(parsed.data.id, variable.ownerId)) {
            await audit(
                user.id,
                variable.orgId,
                variable.scope,
                variable.scopeId,
                "deploy.variable.seal",
                { key: variable.key }
            );
        }
        if (variable.scope === "group") await groups.touchGroup(variable.scopeId);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : await reply("variables.sealFailed")
        };
    }
}

const generatorInputSchema = z.object({
    id: z.string().trim().min(1).max(100),
    // Null takes the generator away; otherwise one `${{ secret(...) }}`.
    generator: z
        .string()
        .trim()
        .max(400)
        .refine((value) => parseGenerator(value) !== null)
        .nullable(),
    regenerate: z.boolean()
});

/**
 * Give a variable a generator - or take it away - so every environment made
 * from this one draws a value of its own. `regenerate` also replaces the value
 * here now; without it, what is running keeps the value it has.
 */
export async function setEnvVarGeneratorAction(input: unknown): Promise<{ error?: string; }> {
    const user = await requirePermission("deploy.manage");
    const parsed = generatorInputSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("variables.generatorInvalid") };
    try {
        const variable = await writableVariable(user, parsed.data.id);
        if (!variable) return { error: await reply("variables.gone") };
        await setEnvVarGenerator(
            parsed.data.id,
            variable.ownerId,
            parsed.data.generator,
            parsed.data.regenerate
        );
        await audit(
            user.id,
            variable.orgId,
            variable.scope,
            variable.scopeId,
            "deploy.variable.set",
            {
                key: variable.key,
                generator: parsed.data.generator,
                regenerated: parsed.data.regenerate && parsed.data.generator !== null
            }
        );
        if (variable.scope === "group") await groups.touchGroup(variable.scopeId);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return {
            error:
                caught instanceof Error ? caught.message : await reply("variables.generatorFailed")
        };
    }
}
