"use server";

/**
 * A managed database's upkeep, from its Manage panel: version upgrades now or
 * in a maintenance window, Redis and MongoDB modes, PostgreSQL point-in-time
 * recovery, copying data in, an object store's buckets, and serving a domain
 * through Cloudflare.
 *
 * Every input is parsed against the schema the panel validates with, every
 * call is gated on the project capability that owns the thing it changes, and
 * every change is written to the audit trail through `recordDeployAudit`.
 * Nothing here returns a password or a stored secret; a bucket key's secret is
 * returned once, by the action that makes it.
 */

import { z } from "zod";
import * as cdn from "@/lib/cdn";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as pitr from "@/lib/database-ops/pitr";
import { requirePermission } from "@/lib/session";
import { copyInto } from "@/lib/database-ops/copy";
import * as store from "@/lib/object-storage/store";
import * as upgrade from "@/lib/database-ops/upgrade";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as settings from "@/lib/database-ops/settings";
import { databaseMembers } from "@/lib/database-ops/topology";
import { requireDatabaseAccess, requireDomainAccess } from "@/lib/deploy-project-access";
import { copySources, databaseOverview, type DatabaseOverview } from "@/lib/database-ops/overview";

const DEPLOY_PATH = "/apps/deploy";

type Result<T = object> = { error?: string } & Partial<T>;

/** The first issue a schema found, in its own words. */
function invalid(error: z.ZodError): { error: string } {
    return { error: error.issues[0]?.message ?? "That request is not valid" };
}

/** An error's words for the screen. Refusals are written for it; anything else
 *  is logged and replaced, since it may name internals. */
function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof Error && !(caught instanceof TypeError) && !caught.name.startsWith("Prisma")) {
        return { error: caught.message };
    }
    console.error(`deploy: ${fallback}:`, caught);
    return { error: fallback };
}

/** Gate a database change and hand back whose it is. */
async function manage(databaseId: string) {
    const user = await requirePermission("deploy.manage");
    const access = await requireDatabaseAccess(databaseId, user.id, "databases.manage");
    return { userId: user.id, ownerId: access.ownerId };
}

async function audit(actorId: string, action: string, databaseId: string, metadata?: Record<string, unknown>) {
    await recordDeployAudit({ actorId, action, targetType: "database", targetId: databaseId, ...(metadata ? { metadata } : {}) });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function databaseOverviewAction(databaseId: string): Promise<Result<{ overview: DatabaseOverview }>> {
    const parsed = z.string().uuid().safeParse(databaseId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const user = await requirePermission("deploy.read");
        const access = await requireDatabaseAccess(parsed.data, user.id, "project.read");
        return { overview: await databaseOverview(parsed.data, access.ownerId) };
    } catch (caught) {
        return failure(caught, "Could not read this database");
    }
}

/** How each member of a replica set, sharded cluster or primary with read
 *  replicas is doing, read from the members themselves. */
export async function databaseMembersAction(
    databaseId: string
): Promise<Result<{ members: Awaited<ReturnType<typeof databaseMembers>> }>> {
    const parsed = z.string().uuid().safeParse(databaseId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const user = await requirePermission("deploy.read");
        const access = await requireDatabaseAccess(parsed.data, user.id, "project.read");
        return { members: await databaseMembers(parsed.data, access.ownerId) };
    } catch (caught) {
        return failure(caught, "Could not read the members");
    }
}

export async function copySourcesAction(
    databaseId: string
): Promise<Result<{ sources: Awaited<ReturnType<typeof copySources>> }>> {
    const parsed = z.string().uuid().safeParse(databaseId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { ownerId } = await manage(parsed.data);
        return { sources: await copySources(parsed.data, ownerId) };
    } catch (caught) {
        return failure(caught, "Could not list the databases to copy from");
    }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Upgrade now, or schedule it for a maintenance window when `at` is given. */
export async function upgradeDatabaseAction(input: z.input<typeof core.databaseUpgradeSchema>): Promise<Result> {
    const parsed = core.databaseUpgradeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        if (parsed.data.at) {
            await upgrade.scheduleUpgrade(parsed.data.databaseId, ownerId, parsed.data.version, new Date(parsed.data.at));
            await audit(userId, "deploy.db.upgrade.schedule", parsed.data.databaseId, {
                version: parsed.data.version,
                at: parsed.data.at
            });
        } else {
            await upgrade.upgradeDatabase(parsed.data.databaseId, ownerId, userId, parsed.data.version);
            await audit(userId, "deploy.db.upgrade", parsed.data.databaseId, { version: parsed.data.version });
        }
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not start the upgrade");
    }
}

export async function cancelUpgradeAction(databaseId: string): Promise<Result> {
    const parsed = z.string().uuid().safeParse(databaseId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data);
        await upgrade.cancelScheduledUpgrade(parsed.data, ownerId);
        await audit(userId, "deploy.db.upgrade.cancel", parsed.data);
        return {};
    } catch (caught) {
        return failure(caught, "Could not cancel the upgrade");
    }
}

export async function revertUpgradeAction(databaseId: string): Promise<Result> {
    const parsed = z.string().uuid().safeParse(databaseId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data);
        await upgrade.revertUpgrade(parsed.data, ownerId, userId);
        await audit(userId, "deploy.db.upgrade.revert", parsed.data);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not go back to the previous version");
    }
}

// ---------------------------------------------------------------------------
// Engine settings
// ---------------------------------------------------------------------------

export async function setRedisModeAction(input: z.input<typeof core.redisModeSchema>): Promise<Result> {
    const parsed = core.redisModeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        await settings.setRedisMode(parsed.data.databaseId, ownerId, userId, parsed.data);
        await audit(userId, "deploy.db.redis-mode", parsed.data.databaseId, {
            mode: parsed.data.mode,
            maxMemoryMb: parsed.data.maxMemoryMb ?? null
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change how Redis keeps its data");
    }
}

export async function setMongoReplicaSetAction(input: z.input<typeof core.mongoReplicaSetSchema>): Promise<Result> {
    const parsed = core.mongoReplicaSetSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        await settings.setMongoReplicaSet(parsed.data.databaseId, ownerId, userId, parsed.data.enabled);
        await audit(userId, "deploy.db.replica-set", parsed.data.databaseId, { enabled: parsed.data.enabled });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the replica set");
    }
}

const databaseLimitsSchema = core.resourceLimitsSchema.extend({ databaseId: z.string().uuid() });

export async function setDatabaseLimitsAction(input: z.input<typeof databaseLimitsSchema>): Promise<Result> {
    const parsed = databaseLimitsSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        const { databaseId, ...limits } = parsed.data;
        await settings.setDatabaseLimits(databaseId, ownerId, userId, limits);
        await audit(userId, "deploy.db.limits", databaseId, limits);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the limits");
    }
}

// ---------------------------------------------------------------------------
// Point-in-time recovery
// ---------------------------------------------------------------------------

export async function setPitrAction(input: z.input<typeof core.pitrSettingsSchema>): Promise<Result> {
    const parsed = core.pitrSettingsSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        await pitr.setPitr(parsed.data.databaseId, ownerId, userId, parsed.data);
        await audit(userId, "deploy.db.pitr", parsed.data.databaseId, {
            enabled: parsed.data.enabled,
            keepDays: parsed.data.keepDays
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change point-in-time recovery");
    }
}

export async function recoverDatabaseAction(
    input: z.input<typeof core.pitrRestoreSchema>
): Promise<Result<{ databaseId: string }>> {
    const parsed = core.pitrRestoreSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        const created = await pitr.recoverToTime(parsed.data.databaseId, ownerId, userId, {
            target: new Date(parsed.data.target),
            name: parsed.data.name
        });
        await audit(userId, "deploy.db.recover", created.databaseId, {
            from: parsed.data.databaseId,
            target: parsed.data.target
        });
        revalidatePath(DEPLOY_PATH);
        return { databaseId: created.databaseId };
    } catch (caught) {
        return failure(caught, "Could not start the recovery");
    }
}

// ---------------------------------------------------------------------------
// Copying data in
// ---------------------------------------------------------------------------

export async function copyIntoDatabaseAction(input: z.input<typeof core.databaseCopySchema>): Promise<Result> {
    const parsed = core.databaseCopySchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.databaseId);
        if (parsed.data.fromDatabaseId) await requireDatabaseAccess(parsed.data.fromDatabaseId, userId, "databases.manage");
        await copyInto(
            parsed.data.databaseId,
            ownerId,
            userId,
            parsed.data.fromDatabaseId ? { fromDatabaseId: parsed.data.fromDatabaseId } : { fromUrl: parsed.data.fromUrl ?? "" }
        );
        // The connection string carries a password: only where the copy came
        // from is recorded, never the string itself.
        await audit(userId, "deploy.db.copy", parsed.data.databaseId, {
            from: parsed.data.fromDatabaseId ?? "connection string"
        });
        return {};
    } catch (caught) {
        return failure(caught, "Could not start the copy");
    }
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

/** Gate a bucket change through the store it belongs to. */
async function manageBucket(bucketId: string) {
    const bucket = await store.bucketStore(bucketId);
    return { ...(await manage(bucket.storeId)), storeId: bucket.storeId };
}

export async function listBucketsAction(
    storeId: string
): Promise<Result<Awaited<ReturnType<typeof store.listBuckets>>>> {
    const parsed = z.string().uuid().safeParse(storeId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { ownerId } = await manage(parsed.data);
        return await store.listBuckets(parsed.data, ownerId);
    } catch (caught) {
        return failure(caught, "Could not list the buckets");
    }
}

export async function createBucketAction(input: z.input<typeof core.bucketCreateSchema>): Promise<Result> {
    const parsed = core.bucketCreateSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId } = await manage(parsed.data.storeId);
        await store.createBucket(parsed.data.storeId, ownerId, parsed.data.name);
        await audit(userId, "deploy.bucket.create", parsed.data.storeId, { bucket: parsed.data.name });
        return {};
    } catch (caught) {
        return failure(caught, "Could not create the bucket");
    }
}

export async function deleteBucketAction(bucketId: string): Promise<Result> {
    const parsed = z.string().uuid().safeParse(bucketId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data);
        await store.deleteBucket(parsed.data, ownerId);
        await audit(userId, "deploy.bucket.delete", storeId, { bucketId: parsed.data });
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the bucket");
    }
}

export async function createBucketKeyAction(
    input: z.input<typeof core.bucketKeySchema>
): Promise<Result<{ accessKey: string; secretKey: string }>> {
    const parsed = core.bucketKeySchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data.bucketId);
        const key = await store.createBucketKey(parsed.data.bucketId, ownerId, parsed.data);
        await audit(userId, "deploy.bucket.key.create", storeId, {
            bucketId: parsed.data.bucketId,
            accessKey: key.accessKey,
            access: parsed.data.access
        });
        return { accessKey: key.accessKey, secretKey: key.secretKey };
    } catch (caught) {
        return failure(caught, "Could not create the key");
    }
}

export async function deleteBucketKeyAction(input: { bucketId: string; keyId: string }): Promise<Result> {
    const parsed = z.object({ bucketId: z.string().uuid(), keyId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data.bucketId);
        await store.deleteBucketKey(parsed.data.bucketId, parsed.data.keyId, ownerId);
        await audit(userId, "deploy.bucket.key.delete", storeId, { keyId: parsed.data.keyId });
        return {};
    } catch (caught) {
        return failure(caught, "Could not revoke the key");
    }
}

export async function setLifecycleRuleAction(input: z.input<typeof core.lifecycleRuleSchema>): Promise<Result> {
    const parsed = core.lifecycleRuleSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data.bucketId);
        await store.setLifecycleRule(parsed.data.bucketId, ownerId, parsed.data);
        await audit(userId, "deploy.bucket.lifecycle", storeId, parsed.data);
        return {};
    } catch (caught) {
        return failure(caught, "Could not set the expiry rule");
    }
}

export async function removeLifecycleRuleAction(input: { bucketId: string; prefix: string }): Promise<Result> {
    const parsed = z
        .object({ bucketId: z.string().uuid(), prefix: z.string().refine(core.isObjectPrefix, "That is not a prefix") })
        .safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data.bucketId);
        await store.removeLifecycleRule(parsed.data.bucketId, ownerId, parsed.data.prefix);
        await audit(userId, "deploy.bucket.lifecycle.remove", storeId, parsed.data);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the expiry rule");
    }
}

export async function presignObjectAction(
    input: z.input<typeof core.presignSchema>
): Promise<Result<{ url: string; expiresAt: string }>> {
    const parsed = core.presignSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data.bucketId);
        const signed = await store.presignObject(parsed.data.bucketId, ownerId, {
            key: parsed.data.key,
            method: parsed.data.method,
            expiresIn: parsed.data.expiresIn,
            ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : {})
        });
        await audit(userId, "deploy.bucket.presign", storeId, {
            bucketId: parsed.data.bucketId,
            key: parsed.data.key,
            method: parsed.data.method,
            expiresIn: parsed.data.expiresIn
        });
        return signed;
    } catch (caught) {
        return failure(caught, "Could not sign the URL");
    }
}

export async function replicationCandidatesAction(
    bucketId: string
): Promise<Result<{ candidates: Awaited<ReturnType<typeof store.replicationCandidates>> }>> {
    const parsed = z.string().uuid().safeParse(bucketId);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { ownerId } = await manageBucket(parsed.data);
        return { candidates: await store.replicationCandidates(parsed.data, ownerId) };
    } catch (caught) {
        return failure(caught, "Could not list the buckets to replicate into");
    }
}

export async function setBucketReplicationAction(input: z.input<typeof core.bucketReplicationSchema>): Promise<Result> {
    const parsed = core.bucketReplicationSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { userId, ownerId, storeId } = await manageBucket(parsed.data.bucketId);
        // The destination's store is written to as well, so it is gated too.
        if (parsed.data.toBucketId) await manageBucket(parsed.data.toBucketId);
        await store.setReplication(parsed.data.bucketId, ownerId, parsed.data.toBucketId);
        await audit(userId, "deploy.bucket.replication", storeId, parsed.data);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the replication");
    }
}

// ---------------------------------------------------------------------------
// Cloudflare CDN
// ---------------------------------------------------------------------------

export async function setDomainCdnAction(input: z.input<typeof core.domainCdnSchema>): Promise<Result> {
    const parsed = core.domainCdnSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const user = await requirePermission("deploy.manage");
        const access = await requireDomainAccess(parsed.data.domainId, user.id, "domains.manage");
        await cdn.setDomainCdn(
            parsed.data.domainId,
            { ownerId: access.ownerId, orgId: access.orgId, actorId: user.id, isAdmin: user.isAdmin },
            parsed.data.enabled
        );
        await recordDeployAudit({
            actorId: user.id,
            action: parsed.data.enabled ? "deploy.domain.cdn.on" : "deploy.domain.cdn.off",
            targetType: "domain",
            targetId: parsed.data.domainId
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change how the domain is served");
    }
}

export async function purgeDomainCacheAction(input: z.input<typeof core.cachePurgeSchema>): Promise<Result> {
    const parsed = core.cachePurgeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const user = await requirePermission("deploy.manage");
        const access = await requireDomainAccess(parsed.data.domainId, user.id, "domains.manage");
        await cdn.purgeDomainCache(
            parsed.data.domainId,
            { ownerId: access.ownerId, orgId: access.orgId, actorId: user.id, isAdmin: user.isAdmin },
            parsed.data.prefix || undefined
        );
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.domain.cdn.purge",
            targetType: "domain",
            targetId: parsed.data.domainId,
            ...(parsed.data.prefix ? { metadata: { prefix: parsed.data.prefix } } : {})
        });
        return {};
    } catch (caught) {
        return failure(caught, "Could not empty the cache");
    }
}
