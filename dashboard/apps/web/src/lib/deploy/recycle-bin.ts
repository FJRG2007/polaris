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
 */

import { z } from "zod";
import { INCLUDING_BINNED, prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import * as restorePoints from "@/lib/restore-points/service";
import { managedProjectWhere } from "@/lib/deploy-project-access";

export const BIN_RETENTION_KEY = "deploy.recycleBin.days";
export const DEFAULT_BIN_DAYS = 30;
export const binDaysSchema = z.coerce.number().int().min(1).max(365);
/** Items purged per scheduled pass, so one pass never runs for long. */
const PURGE_BATCH = 10;

export type BinKind = "application" | "database" | "project";

export async function binRetentionDays(): Promise<number> {
    const parsed = binDaysSchema.safeParse(await getSetting(BIN_RETENTION_KEY));
    return parsed.success ? parsed.data : DEFAULT_BIN_DAYS;
}

export async function setBinRetentionDays(days: number): Promise<void> {
    await setSetting(BIN_RETENTION_KEY, String(binDaysSchema.parse(days)));
}

/** Take a service off its server and into the bin. Its volumes are untouched. */
export async function binApplication(applicationId: string, ownerId: string, actorId: string, at = new Date()): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
    const deploy = await import("@/lib/deploy-service");
    // The routes as they were, so a restore turns back on exactly the names that answered.
    await restorePoints.capture("routes", restorePoints.restoreKeys.routes(applicationId), { actorId });
    await prisma.domain.updateMany({ where: { applicationId }, data: { enabled: false } });
    await deploy.syncAppRoutes().catch(() => undefined);
    await deploy.removeApplicationDeployment(applicationId, ownerId).catch((error: unknown) => {
        console.error(`recycle-bin: could not stop service ${applicationId}:`, error);
    });
    await prisma.application.update({ where: { id: applicationId }, data: { binnedAt: at, binnedById: actorId } });
}

/** Take a database's container down and into the bin. Its data volume stays. */
export async function binDatabase(databaseId: string, ownerId: string, actorId: string, at = new Date()): Promise<void> {
    const db = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: { id: true, parentId: true }
    });
    if (!db) throw new Error("Database not found");
    // A database inside another instance has no container of its own; its data
    // lives in the instance and stays exactly where it is.
    if (!db.parentId) {
        const { stopDatabaseForBin } = await import("@/lib/database-service");
        await stopDatabaseForBin(databaseId, ownerId).catch((error: unknown) => {
            console.error(`recycle-bin: could not stop database ${databaseId}:`, error);
        });
    }
    await prisma.managedDatabase.update({ where: { id: databaseId }, data: { binnedAt: at, binnedById: actorId } });
}

/** Bin a project and everything it runs, all under the same moment. */
export async function binProject(projectId: string, ownerId: string, actorId: string): Promise<void> {
    const project = await prisma.project.findFirst({ where: { id: projectId, ownerId }, select: { id: true } });
    if (!project) throw new Error("Only the project's owner can delete it");
    const at = new Date();
    const [databases, applications] = await Promise.all([
        prisma.managedDatabase.findMany({ where: { environment: { projectId } }, orderBy: { parentId: "desc" }, select: { id: true } }),
        prisma.application.findMany({ where: { environment: { projectId } }, select: { id: true } })
    ]);
    for (const application of applications) await binApplication(application.id, ownerId, actorId, at);
    for (const database of databases) await binDatabase(database.id, ownerId, actorId, at);
    await prisma.project.update({ where: { id: projectId }, data: { binnedAt: at, binnedById: actorId } });
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
    const [days, manages] = await Promise.all([binRetentionDays(), managedProjectWhere(userId)]);
    const binned = { binnedAt: { not: null } };
    const [projects, applications, databases] = await Promise.all([
        prisma.project.findMany({ where: { ...manages, ...binned }, select: { id: true, name: true, binnedAt: true }, take: 200 }),
        prisma.application.findMany({
            where: { ...binned, environment: { project: { ...manages, binnedAt: null } } },
            select: { id: true, name: true, binnedAt: true, environment: { select: { project: { select: { name: true } } } } },
            take: 200
        }),
        prisma.managedDatabase.findMany({
            where: { ...binned, environment: { project: { ...manages, binnedAt: null } } },
            select: { id: true, name: true, binnedAt: true, environment: { select: { project: { select: { name: true } } } } },
            take: 200
        })
    ]);
    const entry = (kind: BinKind, row: { id: string; name: string; binnedAt: Date | null }, projectName: string | null): BinEntry => {
        const at = row.binnedAt ?? new Date();
        return {
            kind,
            id: row.id,
            name: row.name,
            projectName,
            binnedAt: at.toISOString(),
            purgeAt: new Date(at.getTime() + days * 86_400_000).toISOString()
        };
    };
    return [
        ...projects.map((row) => entry("project", row, null)),
        ...applications.map((row) => entry("application", row, row.environment.project.name)),
        ...databases.map((row) => entry("database", row, row.environment.project.name))
    ].sort((a, b) => b.binnedAt.localeCompare(a.binnedAt));
}

async function restoreApplicationRow(applicationId: string, ownerId: string, actorId: string): Promise<void> {
    await prisma.application.update({ where: { id: applicationId }, data: { binnedAt: null, binnedById: null } });
    // The routes snapshot taken when it was binned names the domains that answered.
    const [point] = await restorePoints.listRestorePoints("routes", restorePoints.restoreKeys.routes(applicationId));
    const enabled = point
        ? point.changes.filter((change) => change.fields.some((field) => field.field === "enabled" && field.after === "true")).map((change) => change.item)
        : [];
    if (enabled.length > 0) await prisma.domain.updateMany({ where: { applicationId, hostname: { in: enabled } }, data: { enabled: true } });
    const deploy = await import("@/lib/deploy-service");
    await deploy.syncAppRoutes().catch(() => undefined);
    await deploy.deployApplication(applicationId, ownerId, actorId, { trigger: "manual" }).catch((error: unknown) => {
        console.error(`recycle-bin: restored service ${applicationId} did not redeploy:`, error);
    });
}

async function restoreDatabaseRow(databaseId: string, ownerId: string, actorId: string): Promise<void> {
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

async function ownerOf(kind: BinKind, id: string): Promise<string | null> {
    if (kind === "project") {
        return (await prisma.project.findFirst({ where: { id, ...INCLUDING_BINNED }, select: { ownerId: true } }))?.ownerId ?? null;
    }
    const where = { id, ...INCLUDING_BINNED };
    const row =
        kind === "application"
            ? await prisma.application.findFirst({ where, select: { environment: { select: { project: { select: { ownerId: true } } } } } })
            : await prisma.managedDatabase.findFirst({ where, select: { environment: { select: { project: { select: { ownerId: true } } } } } });
    return row?.environment.project.ownerId ?? null;
}

/**
 * Checks this user may act on the binned item - it is theirs, or on the shelf of
 * an organization they run - and returns the owner whose resources it lives on,
 * which is the id every owner-scoped path below takes.
 */
async function requireBinned(kind: BinKind, id: string, userId: string): Promise<string> {
    const manages = await managedProjectWhere(userId);
    const binned = { id, binnedAt: { not: null } };
    const throughProject = { select: { environment: { select: { project: { select: { ownerId: true } } } } } };
    const ownerId =
        kind === "project"
            ? (await prisma.project.findFirst({ where: { ...binned, ...manages }, select: { ownerId: true } }))?.ownerId
            : kind === "application"
              ? (await prisma.application.findFirst({ where: { ...binned, environment: { project: manages } }, ...throughProject }))
                    ?.environment.project.ownerId
              : (await prisma.managedDatabase.findFirst({ where: { ...binned, environment: { project: manages } }, ...throughProject }))
                    ?.environment.project.ownerId;
    if (!ownerId) throw new Error("That item is no longer in the recycle bin");
    return ownerId;
}

/** Bring an item back and redeploy it. */
export async function restoreFromBin(kind: BinKind, id: string, userId: string, actorId: string): Promise<void> {
    const ownerId = await requireBinned(kind, id, userId);
    if (kind === "application") return restoreApplicationRow(id, ownerId, actorId);
    if (kind === "database") return restoreDatabaseRow(id, ownerId, actorId);
    const project = await prisma.project.findFirst({ where: { id, ownerId, binnedAt: { not: null } }, select: { binnedAt: true } });
    await prisma.project.update({ where: { id }, data: { binnedAt: null, binnedById: null } });
    // Only what was binned with the project; something deleted on its own before stays in the bin.
    const together = { binnedAt: project?.binnedAt ?? undefined, environment: { projectId: id } };
    const [databases, applications] = await Promise.all([
        prisma.managedDatabase.findMany({ where: together, orderBy: { parentId: "asc" }, select: { id: true } }),
        prisma.application.findMany({ where: together, select: { id: true } })
    ]);
    for (const database of databases) await restoreDatabaseRow(database.id, ownerId, actorId);
    for (const application of applications) await restoreApplicationRow(application.id, ownerId, actorId);
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

/** The scheduled purge: what has sat in the bin past the retention period. Bounded. */
export async function purgeRecycleBin(now = new Date()): Promise<{ purged: number }> {
    const cutoff = new Date(now.getTime() - (await binRetentionDays()) * 86_400_000);
    const expired = { binnedAt: { lt: cutoff } };
    const [projects, applications, databases] = await Promise.all([
        prisma.project.findMany({ where: expired, select: { id: true }, take: PURGE_BATCH }),
        prisma.application.findMany({ where: { ...expired, environment: { project: { binnedAt: null } } }, select: { id: true }, take: PURGE_BATCH }),
        prisma.managedDatabase.findMany({ where: { ...expired, environment: { project: { binnedAt: null } } }, select: { id: true }, take: PURGE_BATCH })
    ]);
    const queue: Array<[BinKind, string]> = [
        ...projects.map((row): [BinKind, string] => ["project", row.id]),
        ...applications.map((row): [BinKind, string] => ["application", row.id]),
        ...databases.map((row): [BinKind, string] => ["database", row.id])
    ].slice(0, PURGE_BATCH);
    let purged = 0;
    for (const [kind, id] of queue) {
        const owner = await ownerOf(kind, id);
        if (!owner) continue;
        try {
            await deleteForever(kind, id, owner);
            purged += 1;
        } catch (error) {
            console.error(`recycle-bin: could not purge ${kind} ${id}:`, error);
        }
    }
    return { purged };
}
