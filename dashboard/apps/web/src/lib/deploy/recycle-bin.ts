/**
 * The recycle bin for Deploy: a deleted service, project or managed database is
 * taken off its server (no container left using CPU or memory) but its volumes,
 * database files and rows stay, hidden, for a retention period. Restore brings
 * it back and redeploys it; "delete forever" and the scheduled purge hand it to
 * the real delete, which frees the data.
 *
 * Names: a binned item keeps its slug and its domains. The slug is unique per
 * environment and a hostname is unique instance-wide, so nothing else can take
 * them while it is in the bin, and a restore never comes back to a name that is
 * now somebody else's. Deleting it forever (or the purge) releases them. Domains
 * are disabled while binned, so the names stop answering at once.
 *
 * Hiding is done once, in the database client (`hidingBinned` in @polaris/db):
 * every top-level read of these three models leaves binned rows out unless it
 * names `binnedAt`, which is what this module does with `INCLUDING_BINNED`.
 *
 * Whether there is a bin at all, and how long it keeps things, belongs to whoever
 * the project belongs to: the person for a personal project, the organization for
 * one on its shelf. With the bin off, deleting removes for good straight away.
 * Nothing has to be configured: unset, the bin is on and keeps things for the
 * instance-wide number of days an earlier version stored, else 30.
 */

import {
    DEFAULT_BIN_DAYS,
    binDaysSchema,
    binPolicySchema,
    type BinPolicy
} from "@/lib/deploy/recycle-bin-policy";
import { INCLUDING_BINNED, prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import * as restorePoints from "@/lib/restore-points/service";
import { managedProjectWhere } from "@/lib/deploy-project-access";
import * as quotas from "@/lib/orgs/quotas";
import * as quota from "@/lib/orgs/quota-service";

/** The instance-wide retention an earlier version kept; now only the default. */
export const BIN_RETENTION_KEY = "deploy.recycleBin.days";
export { DEFAULT_BIN_DAYS, binDaysSchema, binPolicySchema, type BinPolicy };
/** Items purged per scheduled pass, so one pass never runs for long. */
const PURGE_BATCH = 10;
/** Stored policies read per page during a purge pass. */
const POLICY_SCAN = 5000;
const ORG_POLICY_PREFIX = "deploy.recycleBin.org.";
const USER_POLICY_PREFIX = "deploy.recycleBin.user.";

export type BinKind = "application" | "database" | "project";

/** Whose bin it is: an organization's, or the person's own for a personal project. */
export interface BinScope {
    readonly orgId: string | null;
    readonly userId: string;
}

export function policyKey(scope: BinScope): string {
    return scope.orgId
        ? `${ORG_POLICY_PREFIX}${scope.orgId}`
        : `${USER_POLICY_PREFIX}${scope.userId}`;
}

/** What a scope that never chose gets: on, for the instance's old number of days. */
export async function defaultBinPolicy(): Promise<BinPolicy> {
    return { enabled: true, days: await binRetentionDays() };
}

/**
 * The instance-wide number of days, now only the default for a scope that never
 * chose its own.
 * @deprecated Read a scope's policy with `binPolicyFor`.
 */
export async function binRetentionDays(): Promise<number> {
    const parsed = binDaysSchema.safeParse(await getSetting(BIN_RETENTION_KEY));
    return parsed.success ? parsed.data : DEFAULT_BIN_DAYS;
}

/**
 * Change the instance-wide default.
 * @deprecated Each owner sets their own with `setBinPolicy`.
 */
export async function setBinRetentionDays(days: number): Promise<void> {
    await setSetting(BIN_RETENTION_KEY, String(binDaysSchema.parse(days)));
}

/** Read a stored policy, falling back to the default for anything unreadable. */
export function parseBinPolicy(stored: string | null, fallback: BinPolicy): BinPolicy {
    if (!stored) return fallback;
    try {
        const parsed = binPolicySchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : fallback;
    } catch {
        return fallback;
    }
}

export async function binPolicyFor(scope: BinScope): Promise<BinPolicy> {
    const [stored, fallback] = await Promise.all([
        getSetting(policyKey(scope)),
        defaultBinPolicy()
    ]);
    return parseBinPolicy(stored, fallback);
}

export async function setBinPolicy(scope: BinScope, policy: BinPolicy): Promise<BinPolicy> {
    const parsed = binPolicySchema.parse(policy);
    await setSetting(policyKey(scope), JSON.stringify(parsed));
    return parsed;
}

/** The policy a project's deletes follow, binned or not. */
export async function binPolicyOfProject(projectId: string): Promise<BinPolicy> {
    const project = await prisma.project.findFirst({
        where: { id: projectId, ...INCLUDING_BINNED },
        select: { ownerId: true, orgId: true }
    });
    return project
        ? binPolicyFor({ orgId: project.orgId, userId: project.ownerId })
        : defaultBinPolicy();
}

/** Remembers each scope's policy for one listing or purge pass. */
function policyCache(): (scope: BinScope) => Promise<BinPolicy> {
    const seen = new Map<string, Promise<BinPolicy>>();
    return (scope) => {
        const key = policyKey(scope);
        let policy = seen.get(key);
        if (!policy) {
            policy = binPolicyFor(scope);
            seen.set(key, policy);
        }
        return policy;
    };
}

/** When an item binned at `binnedAt` goes for good under `policy`. */
export function purgeDate(binnedAt: Date, policy: BinPolicy): Date {
    return new Date(binnedAt.getTime() + policy.days * 86_400_000);
}

/**
 * Delete a service: into the bin with its volumes untouched, or for good when
 * its owner keeps no bin.
 */
export async function binApplication(
    applicationId: string,
    ownerId: string,
    actorId: string,
    at = new Date()
): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, environment: { select: { projectId: true } } }
    });
    if (!app) throw new Error("Application not found");
    if (!(await binPolicyOfProject(app.environment.projectId)).enabled) {
        const deploy = await import("@/lib/deploy-service");
        await deploy.deleteApplication(applicationId, ownerId, { deleteData: true });
        return;
    }
    await moveApplicationToBin(applicationId, ownerId, actorId, at);
}

async function moveApplicationToBin(
    applicationId: string,
    ownerId: string,
    actorId: string,
    at: Date
): Promise<void> {
    const deploy = await import("@/lib/deploy-service");
    // The routes as they were, so a restore turns back on exactly the names that answered.
    await restorePoints.capture("routes", restorePoints.restoreKeys.routes(applicationId), {
        actorId
    });
    await prisma.domain.updateMany({ where: { applicationId }, data: { enabled: false } });
    await deploy.syncAppRoutes().catch(() => undefined);
    await deploy.removeApplicationDeployment(applicationId, ownerId).catch((error: unknown) => {
        console.error(`recycle-bin: could not stop service ${applicationId}:`, error);
    });
    await prisma.application.update({
        where: { id: applicationId },
        data: { binnedAt: at, binnedById: actorId }
    });
}

/**
 * Delete a database: its container down and into the bin with its data volume
 * kept, or for good when its owner keeps no bin.
 */
export async function binDatabase(
    databaseId: string,
    ownerId: string,
    actorId: string,
    at = new Date()
): Promise<void> {
    const db = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: { id: true, parentId: true, environment: { select: { projectId: true } } }
    });
    if (!db) throw new Error("Database not found");
    if (!(await binPolicyOfProject(db.environment.projectId)).enabled) {
        const { deleteDatabase } = await import("@/lib/database-service");
        await deleteDatabase(databaseId, ownerId);
        return;
    }
    await moveDatabaseToBin(databaseId, db.parentId, ownerId, actorId, at);
}

async function moveDatabaseToBin(
    databaseId: string,
    parentId: string | null,
    ownerId: string,
    actorId: string,
    at: Date
): Promise<void> {
    // A database inside another instance has no container of its own; its data
    // lives in the instance and stays exactly where it is.
    if (!parentId) {
        const { stopDatabaseForBin } = await import("@/lib/database-service");
        await stopDatabaseForBin(databaseId, ownerId).catch((error: unknown) => {
            console.error(`recycle-bin: could not stop database ${databaseId}:`, error);
        });
    }
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { binnedAt: at, binnedById: actorId }
    });
}

/**
 * Delete a project and everything it runs: into the bin all under the same
 * moment, or for good when its owner keeps no bin.
 */
export async function binProject(
    projectId: string,
    ownerId: string,
    actorId: string
): Promise<void> {
    const project = await prisma.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true, orgId: true }
    });
    if (!project) throw new Error("Only the project's owner can delete it");
    if (!(await binPolicyFor({ orgId: project.orgId, userId: ownerId })).enabled) {
        const deploy = await import("@/lib/deploy-service");
        await deploy.deleteProject(projectId, ownerId);
        return;
    }
    const at = new Date();
    const [databases, applications] = await Promise.all([
        prisma.managedDatabase.findMany({
            where: { environment: { projectId } },
            orderBy: { parentId: "desc" },
            select: { id: true, parentId: true }
        }),
        prisma.application.findMany({ where: { environment: { projectId } }, select: { id: true } })
    ]);
    for (const application of applications)
        await moveApplicationToBin(application.id, ownerId, actorId, at);
    for (const database of databases)
        await moveDatabaseToBin(database.id, database.parentId, ownerId, actorId, at);
    await prisma.project.update({
        where: { id: projectId },
        data: { binnedAt: at, binnedById: actorId }
    });
}

export interface BinEntry {
    readonly kind: BinKind;
    readonly id: string;
    readonly name: string;
    /** The project it belonged to, for a service or database. */
    readonly projectName: string | null;
    readonly binnedAt: string;
    readonly purgeAt: string;
}

/**
 * What this user has in the bin: their own projects' items and those of every
 * organization they run. A project's contents are listed as the project, not one
 * by one: they come back and go together.
 */
export async function listBin(userId: string): Promise<BinEntry[]> {
    const manages = await managedProjectWhere(userId);
    const binned = { binnedAt: { not: null } };
    const scope = { ownerId: true, orgId: true } as const;
    const throughProject = {
        id: true,
        name: true,
        binnedAt: true,
        environment: { select: { project: { select: { name: true, ...scope } } } }
    } as const;
    const [projects, applications, databases] = await Promise.all([
        prisma.project.findMany({
            where: { ...manages, ...binned },
            select: { id: true, name: true, binnedAt: true, ...scope },
            take: 200
        }),
        prisma.application.findMany({
            where: { ...binned, environment: { project: { ...manages, binnedAt: null } } },
            select: throughProject,
            take: 200
        }),
        prisma.managedDatabase.findMany({
            where: { ...binned, environment: { project: { ...manages, binnedAt: null } } },
            select: throughProject,
            take: 200
        })
    ]);
    const policyOf = policyCache();
    const entry = async (
        kind: BinKind,
        row: { id: string; name: string; binnedAt: Date | null },
        project: { name: string | null; ownerId: string; orgId: string | null }
    ): Promise<BinEntry> => {
        const at = row.binnedAt ?? new Date();
        const policy = await policyOf({ orgId: project.orgId, userId: project.ownerId });
        return {
            kind,
            id: row.id,
            name: row.name,
            projectName: project.name,
            binnedAt: at.toISOString(),
            purgeAt: purgeDate(at, policy).toISOString()
        };
    };
    const entries = await Promise.all([
        ...projects.map((row) => entry("project", row, { ...row, name: null })),
        ...applications.map((row) => entry("application", row, row.environment.project)),
        ...databases.map((row) => entry("database", row, row.environment.project))
    ]);
    return entries.sort((a, b) => b.binnedAt.localeCompare(a.binnedAt));
}

async function restoreApplicationRow(
    applicationId: string,
    ownerId: string,
    actorId: string
): Promise<void> {
    await prisma.application.update({
        where: { id: applicationId },
        data: { binnedAt: null, binnedById: null }
    });
    // The routes snapshot taken when it was binned names the domains that answered.
    const [point] = await restorePoints.listRestorePoints(
        "routes",
        restorePoints.restoreKeys.routes(applicationId)
    );
    const enabled = point
        ? point.changes
              .filter((change) =>
                  change.fields.some((field) => field.field === "enabled" && field.after === "true")
              )
              .map((change) => change.item)
        : [];
    if (enabled.length > 0)
        await prisma.domain.updateMany({
            where: { applicationId, hostname: { in: enabled } },
            data: { enabled: true }
        });
    const deploy = await import("@/lib/deploy-service");
    await deploy.syncAppRoutes().catch(() => undefined);
    await deploy
        .deployApplication(applicationId, ownerId, actorId, { trigger: "manual" })
        .catch((error: unknown) => {
            console.error(
                `recycle-bin: restored service ${applicationId} did not redeploy:`,
                error
            );
        });
}

async function restoreDatabaseRow(
    databaseId: string,
    ownerId: string,
    actorId: string
): Promise<void> {
    const db = await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { binnedAt: null, binnedById: null },
        select: { parentId: true }
    });
    if (db.parentId) return;
    const { deployDatabase } = await import("@/lib/database-service");
    await deployDatabase(databaseId, ownerId, actorId).catch((error: unknown) => {
        console.error(`recycle-bin: restored database ${databaseId} did not redeploy:`, error);
    });
}

/**
 * Checks this user may act on the binned item - it is theirs, or on the shelf of
 * an organization they run - and returns the owner whose resources it lives on,
 * which is the id every owner-scoped path below takes.
 */
async function requireBinned(kind: BinKind, id: string, userId: string): Promise<string> {
    const manages = await managedProjectWhere(userId);
    const binned = { id, binnedAt: { not: null } };
    const throughProject = {
        select: { environment: { select: { project: { select: { ownerId: true } } } } }
    };
    const ownerId =
        kind === "project"
            ? (
                  await prisma.project.findFirst({
                      where: { ...binned, ...manages },
                      select: { ownerId: true }
                  })
              )?.ownerId
            : kind === "application"
              ? (
                    await prisma.application.findFirst({
                        where: { ...binned, environment: { project: manages } },
                        ...throughProject
                    })
                )?.environment.project.ownerId
              : (
                    await prisma.managedDatabase.findFirst({
                        where: { ...binned, environment: { project: manages } },
                        ...throughProject
                    })
                )?.environment.project.ownerId;
    if (!ownerId) throw new Error("That item is no longer in the recycle bin");
    return ownerId;
}

/**
 * Refuse a restore that would take the organization past one of its caps. A
 * binned item counts toward none of them, so bringing it back is one more of
 * everything it is: a project returns with the services and databases binned
 * along with it, and each returns with what its limits reserve.
 */
async function assertRoomToRestore(kind: BinKind, id: string): Promise<void> {
    const binned = { id, binnedAt: { not: null } };
    const inProject = { select: { environment: { select: { project: { select: { orgId: true } } } } } };
    const limits = { cpuLimit: true, memoryLimitMb: true } as const;
    let orgId: string | null = null;
    let projects = 0;
    let applications: { replicas: number; cpuLimit: number | null; memoryLimitMb: number | null }[] = [];
    let databases: { members: number; parentId: string | null; cpuLimit: number | null; memoryLimitMb: number | null }[] = [];
    if (kind === "application") {
        const row = await prisma.application.findFirst({
            where: binned,
            select: { ...limits, replicas: true, ...inProject.select }
        });
        if (!row) return;
        orgId = row.environment.project.orgId;
        applications = [row];
    } else if (kind === "database") {
        const row = await prisma.managedDatabase.findFirst({
            where: binned,
            select: { ...limits, members: true, parentId: true, ...inProject.select }
        });
        if (!row) return;
        orgId = row.environment.project.orgId;
        databases = [row];
    } else {
        const project = await prisma.project.findFirst({ where: binned, select: { orgId: true, binnedAt: true } });
        if (!project?.binnedAt) return;
        orgId = project.orgId;
        projects = 1;
        const together = { binnedAt: project.binnedAt, environment: { projectId: id } };
        [applications, databases] = await Promise.all([
            prisma.application.findMany({ where: together, select: { ...limits, replicas: true } }),
            prisma.managedDatabase.findMany({ where: together, select: { ...limits, members: true, parentId: true } })
        ]);
    }
    if (!orgId) return;
    await quota.assertOrgRoom(orgId, "projects", projects);
    await quota.assertOrgRoom(orgId, "services", applications.length);
    await quota.assertOrgRoom(orgId, "databases", databases.length);
    // A database hosted inside another instance has no container of its own.
    const dedicated = databases.filter((database) => !database.parentId);
    await quota.assertOrgReservation(
        orgId,
        { cpus: 0, memoryMb: 0 },
        {
            cpus:
                applications.reduce((sum, app) => sum + quotas.reservationOf(app.cpuLimit, app.replicas), 0) +
                dedicated.reduce((sum, db) => sum + quotas.reservationOf(db.cpuLimit, db.members), 0),
            memoryMb:
                applications.reduce((sum, app) => sum + quotas.reservationOf(app.memoryLimitMb, app.replicas), 0) +
                dedicated.reduce((sum, db) => sum + quotas.reservationOf(db.memoryLimitMb, db.members), 0)
        }
    );
}

/** Bring an item back and redeploy it. */
export async function restoreFromBin(
    kind: BinKind,
    id: string,
    userId: string,
    actorId: string
): Promise<void> {
    const ownerId = await requireBinned(kind, id, userId);
    await assertRoomToRestore(kind, id);
    if (kind === "application") return restoreApplicationRow(id, ownerId, actorId);
    if (kind === "database") return restoreDatabaseRow(id, ownerId, actorId);
    const project = await prisma.project.findFirst({
        where: { id, ownerId, binnedAt: { not: null } },
        select: { binnedAt: true }
    });
    await prisma.project.update({ where: { id }, data: { binnedAt: null, binnedById: null } });
    // Only what was binned with the project; something deleted on its own before stays in the bin.
    const together = { binnedAt: project?.binnedAt ?? undefined, environment: { projectId: id } };
    const [databases, applications] = await Promise.all([
        prisma.managedDatabase.findMany({
            where: together,
            orderBy: { parentId: "asc" },
            select: { id: true }
        }),
        prisma.application.findMany({ where: together, select: { id: true } })
    ]);
    for (const database of databases) await restoreDatabaseRow(database.id, ownerId, actorId);
    for (const application of applications)
        await restoreApplicationRow(application.id, ownerId, actorId);
}

/** Delete for good, data included. Releases the names it held. */
export async function deleteForever(kind: BinKind, id: string, userId: string): Promise<void> {
    const ownerId = await requireBinned(kind, id, userId);
    // Out of the bin first, so the ordinary delete (which reads it like any other
    // row) finds it. A delete that then fails leaves it listed and stopped, never
    // hidden with its data still on disk.
    const unbin = { binnedAt: null, binnedById: null };
    const deploy = await import("@/lib/deploy-service");
    if (kind === "application") {
        await prisma.application.updateMany({ where: { id }, data: unbin });
        return deploy.deleteApplication(id, ownerId, { deleteData: true });
    }
    if (kind === "database") {
        await prisma.managedDatabase.updateMany({ where: { id }, data: unbin });
        const { deleteDatabase } = await import("@/lib/database-service");
        return deleteDatabase(id, ownerId);
    }
    // The project's own contents are unbinned by its teardown (see tearDownEnvironment).
    await prisma.project.updateMany({ where: { id }, data: unbin });
    return deploy.deleteProject(id, ownerId);
}

/** Which projects a retention applies to, as a project filter. */
type ProjectScopeWhere = Record<string, unknown>;

export interface RetentionGroup {
    readonly days: number;
    readonly project: ProjectScopeWhere;
}

function scopeClauses(orgIds: readonly string[], userIds: readonly string[]): ProjectScopeWhere[] {
    return [
        ...(orgIds.length > 0 ? [{ orgId: { in: [...orgIds] } }] : []),
        ...(userIds.length > 0 ? [{ orgId: null, ownerId: { in: [...userIds] } }] : [])
    ];
}

/**
 * The stored policies, grouped by how long they keep things, each with the
 * projects it covers; plus the default for every scope that never chose. A bin
 * switched off still lets what is already in it run out its days.
 */
export function retentionGroups(
    stored: readonly { key: string; value: string }[],
    fallback: BinPolicy
): RetentionGroup[] {
    const byDays = new Map<number, { orgIds: string[]; userIds: string[] }>();
    const allOrgs: string[] = [];
    const allUsers: string[] = [];
    for (const row of stored) {
        const isOrg = row.key.startsWith(ORG_POLICY_PREFIX);
        const isUser = row.key.startsWith(USER_POLICY_PREFIX);
        if (!isOrg && !isUser) continue;
        const id = row.key.slice((isOrg ? ORG_POLICY_PREFIX : USER_POLICY_PREFIX).length);
        if (!id) continue;
        const { days } = parseBinPolicy(row.value, fallback);
        const group = byDays.get(days) ?? { orgIds: [], userIds: [] };
        (isOrg ? group.orgIds : group.userIds).push(id);
        (isOrg ? allOrgs : allUsers).push(id);
        byDays.set(days, group);
    }
    return [
        ...[...byDays].map(([days, group]) => ({
            days,
            project: { OR: scopeClauses(group.orgIds, group.userIds) }
        })),
        { days: fallback.days, project: unchosenScopes(allOrgs, allUsers) }
    ];
}

/** Every project whose owner has no policy of its own, never negating a nullable column. */
function unchosenScopes(orgIds: readonly string[], userIds: readonly string[]): ProjectScopeWhere {
    if (orgIds.length === 0 && userIds.length === 0) return {};
    return {
        OR: [
            { orgId: orgIds.length > 0 ? { not: null, notIn: [...orgIds] } : { not: null } },
            userIds.length > 0 ? { orgId: null, ownerId: { notIn: [...userIds] } } : { orgId: null }
        ]
    };
}

/** Every stored policy, read in pages so no owner is left to the default. */
async function storedPolicies(): Promise<{ key: string; value: string }[]> {
    const rows: { key: string; value: string }[] = [];
    let cursor: string | undefined;
    for (;;) {
        const page = await prisma.setting.findMany({
            where: {
                OR: [
                    { key: { startsWith: ORG_POLICY_PREFIX } },
                    { key: { startsWith: USER_POLICY_PREFIX } }
                ],
                ...(cursor ? { key: { gt: cursor } } : {})
            },
            select: { key: true, value: true },
            orderBy: { key: "asc" },
            take: POLICY_SCAN
        });
        rows.push(...page);
        if (page.length < POLICY_SCAN) return rows;
        cursor = page[page.length - 1]?.key;
    }
}

/**
 * The scheduled purge: what has sat in its owner's bin past that owner's
 * retention. Bounded: a few items per pass, a few reads per retention in use.
 */
export async function purgeRecycleBin(now = new Date()): Promise<{ purged: number }> {
    const [stored, fallback] = await Promise.all([storedPolicies(), defaultBinPolicy()]);
    const queue: Array<[BinKind, string, string]> = [];
    const ownerOf = {
        environment: { select: { project: { select: { ownerId: true } } } }
    } as const;
    for (const group of retentionGroups(stored, fallback)) {
        if (queue.length >= PURGE_BATCH) break;
        const expired = { binnedAt: { lt: new Date(now.getTime() - group.days * 86_400_000) } };
        const take = PURGE_BATCH - queue.length;
        const inProject = { environment: { project: { ...group.project, binnedAt: null } } };
        const [projects, applications, databases] = await Promise.all([
            prisma.project.findMany({
                where: { ...group.project, ...expired },
                select: { id: true, ownerId: true },
                orderBy: { binnedAt: "asc" },
                take
            }),
            prisma.application.findMany({
                where: { ...expired, ...inProject },
                select: { id: true, ...ownerOf },
                orderBy: { binnedAt: "asc" },
                take
            }),
            prisma.managedDatabase.findMany({
                where: { ...expired, ...inProject },
                select: { id: true, ...ownerOf },
                orderBy: { binnedAt: "asc" },
                take
            })
        ]);
        queue.push(
            ...projects.map((row): [BinKind, string, string] => ["project", row.id, row.ownerId]),
            ...applications.map((row): [BinKind, string, string] => [
                "application",
                row.id,
                row.environment.project.ownerId
            ]),
            ...databases.map((row): [BinKind, string, string] => [
                "database",
                row.id,
                row.environment.project.ownerId
            ])
        );
    }
    let purged = 0;
    for (const [kind, id, ownerId] of queue.slice(0, PURGE_BATCH)) {
        try {
            await deleteForever(kind, id, ownerId);
            purged += 1;
        } catch (error) {
            console.error(`recycle-bin: could not purge ${kind} ${id}:`, error);
        }
    }
    return { purged };
}
