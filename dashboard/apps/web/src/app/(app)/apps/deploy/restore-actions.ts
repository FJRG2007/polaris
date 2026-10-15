"use server";

/**
 * History (restore points) and the recycle bin, for the screens that show them.
 * Each kind is checked with the same capability that edits it, so a reader who
 * cannot change an object cannot roll it back either.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { getWafRule } from "@/lib/waf-service";
import { requirePermission } from "@/lib/session";
import { requireVariableScopeAccess } from "@/lib/deploy/variable-groups";
import { recordAudit } from "@/lib/audit-service";
import * as recycleBin from "@/lib/deploy/recycle-bin";
import { openShelfBinPolicy } from "@/lib/deploy/recycle-bin-access";
import * as restorePoints from "@/lib/restore-points/service";
import { requireApplicationAccess, requireEnvironmentAccess } from "@/lib/deploy-project-access";

const targetSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("env"),
        scope: z.enum(["application", "environment", "group"]),
        scopeId: z.string().uuid()
    }),
    z.object({ kind: z.literal("cron"), applicationId: z.string().uuid() }),
    z.object({ kind: z.literal("routes"), applicationId: z.string().uuid() }),
    z.object({
        kind: z.literal("firewall"),
        scopeType: z.enum(core.WAF_SCOPE_TYPES),
        scopeId: z.string().max(64)
    }),
    z.object({ kind: z.literal("dns"), zoneId: z.string().min(1).max(64) })
]);
export type HistoryTarget = z.infer<typeof targetSchema>;

interface Resolved {
    kind: restorePoints.RestorePointKindName;
    objectKey: string;
    ownerId: string;
    orgId: string | null;
}

/** Checks access for the target and names the object it is about. */
async function resolve(raw: unknown, write: boolean): Promise<Resolved> {
    const target = targetSchema.parse(raw);
    const user = await requirePermission(write ? "deploy.manage" : "deploy.read");
    switch (target.kind) {
        case "env": {
            if (target.scope === "group") {
                const group = await requireVariableScopeAccess(
                    "group",
                    target.scopeId,
                    user,
                    write ? "variables.write" : "variables.read",
                    { reveal: true }
                );
                const objectKey = restorePoints.restoreKeys.env("group", target.scopeId);
                return { kind: "env", objectKey, ownerId: group.ownerId, orgId: group.orgId };
            }
            const access =
                target.scope === "application"
                    ? await requireApplicationAccess(
                          target.scopeId,
                          user.id,
                          write ? "variables.write" : "variables.read"
                      )
                    : await requireEnvironmentAccess(
                          target.scopeId,
                          user.id,
                          write ? "variables.write" : "variables.read"
                      );
            const objectKey = restorePoints.restoreKeys.env(target.scope, target.scopeId);
            return { kind: "env", objectKey, ownerId: access.ownerId, orgId: access.orgId };
        }
        case "cron":
        case "routes": {
            const capability = target.kind === "cron" ? "console.use" : "domains.manage";
            const access = await requireApplicationAccess(
                target.applicationId,
                user.id,
                write ? capability : "project.read"
            );
            return {
                kind: target.kind,
                objectKey: target.applicationId,
                ownerId: access.ownerId,
                orgId: access.orgId
            };
        }
        case "firewall": {
            if (target.scopeType === "polaris" || target.scopeType === "global")
                await requirePermission("system.manage");
            // Refuses a scope the reader does not own, the same check its editor uses.
            await getWafRule(user.id, target.scopeType, target.scopeId);
            const objectKey = restorePoints.restoreKeys.firewall(target.scopeType, target.scopeId);
            return { kind: "firewall", objectKey, ownerId: user.id, orgId: null };
        }
        case "dns": {
            await requirePermission("system.manage");
            const objectKey = restorePoints.restoreKeys.dns({
                kind: "instance",
                zoneId: target.zoneId
            });
            return { kind: "dns", objectKey, ownerId: user.id, orgId: null };
        }
    }
}

export async function listHistoryAction(
    target: HistoryTarget
): Promise<{ points?: restorePoints.RestorePointView[]; error?: string }> {
    try {
        const resolved = await resolve(target, false);
        return { points: await restorePoints.listRestorePoints(resolved.kind, resolved.objectKey) };
    } catch (error) {
        console.error("polaris: could not list restore points:", error);
        return { error: "unavailable" };
    }
}

export async function restoreHistoryAction(
    target: HistoryTarget,
    pointId: string
): Promise<{ error?: string }> {
    try {
        const id = z.string().uuid().parse(pointId);
        const resolved = await resolve(target, true);
        const user = await requirePermission("deploy.manage");
        await restorePoints.restorePoint(id, resolved, {
            id: user.id,
            ownerId: resolved.ownerId,
            orgId: resolved.orgId
        });
        revalidatePath("/apps/deploy");
        return {};
    } catch (error) {
        console.error("polaris: could not restore a point:", error);
        return { error: "restoreFailed" };
    }
}

const binItemSchema = z.object({
    kind: z.enum(["application", "database", "project"]),
    id: z.string().uuid()
});

export async function listBinAction(): Promise<{
    entries?: recycleBin.BinEntry[];
    /** The open shelf's bin: off means deletes there skip it. */
    policy?: recycleBin.BinPolicy;
    /** @deprecated Each entry carries its own `purgeAt`; read `policy.days`. */
    days?: number;
    error?: string;
}> {
    try {
        const user = await requirePermission("deploy.read");
        const [entries, view] = await Promise.all([
            recycleBin.listBin(user.id),
            openShelfBinPolicy(user)
        ]);
        return { entries, policy: view.policy, days: view.policy.days };
    } catch (error) {
        console.error("polaris: could not list the recycle bin:", error);
        return { error: "unavailable" };
    }
}

export async function binItemAction(
    action: "restore" | "forget",
    raw: { kind: string; id: string }
): Promise<{ error?: string }> {
    try {
        const item = binItemSchema.parse(raw);
        const verb = z.enum(["restore", "forget"]).parse(action);
        const user = await requirePermission("deploy.manage");
        // Access is checked on this item: it has to be the user's own, or on the
        // shelf of an organization they run (see recycle-bin requireBinned).
        if (verb === "restore")
            await recycleBin.restoreFromBin(item.kind, item.id, user.id, user.id);
        else await recycleBin.deleteForever(item.kind, item.id, user.id);
        await recordAudit({
            actorId: user.id,
            action: verb === "restore" ? "deploy.bin.restore" : "deploy.bin.delete",
            targetType: item.kind,
            targetId: item.id
        });
        revalidatePath("/apps/deploy");
        return {};
    } catch (error) {
        console.error("polaris: recycle bin action failed:", error);
        return { error: action === "restore" ? "binRestoreFailed" : "binDeleteFailed" };
    }
}

/**
 * The instance-wide default for owners that never chose.
 * @deprecated The bin is set per owner with `setBinPolicyAction`.
 */
export async function setBinDaysAction(days: number): Promise<{ error?: string }> {
    try {
        const user = await requirePermission("system.manage");
        const parsed = recycleBin.binDaysSchema.parse(days);
        await recycleBin.setBinRetentionDays(parsed);
        await recordAudit({
            actorId: user.id,
            action: "deploy.bin.retention",
            metadata: { days: parsed }
        });
        return {};
    } catch {
        return { error: "daysInvalid" };
    }
}

/** Switch the open shelf's bin on or off and set how long it keeps things. */
export async function setBinPolicyAction(
    input: unknown
): Promise<{ policy?: recycleBin.BinPolicy; error?: "invalid" | "forbidden" | "failed" }> {
    const parsed = recycleBin.binPolicySchema.safeParse(input);
    if (!parsed.success) return { error: "invalid" };
    const user = await requirePermission("deploy.read");
    try {
        const view = await openShelfBinPolicy(user);
        if (view.lock) return { error: "forbidden" };
        const policy = await recycleBin.setBinPolicy(view.scope, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "deploy.bin.policy",
            ...(view.scope.orgId ? { orgId: view.scope.orgId } : {}),
            metadata: { enabled: policy.enabled, days: policy.days }
        });
        revalidatePath("/apps/deploy/settings");
        return { policy };
    } catch (error) {
        console.error("polaris: could not save the recycle bin policy:", error);
        return { error: "failed" };
    }
}
