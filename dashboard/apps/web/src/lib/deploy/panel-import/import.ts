/**
 * Turning a cPanel account backup into a Polaris project.
 *
 * The backup is checked and unpacked by `inspectCpanelBackup`, then carried over
 * with the same functions the Deploy screens use, so an imported project is made
 * exactly like one made by hand:
 *
 *   - a project, on the shelf the importer works from;
 *   - one MySQL instance, holding every dump in `mysql/` (the first as the
 *     instance's own database, the rest as databases inside it), each loaded
 *     through the console's restore path;
 *   - one service per site folder (a document root that more than one domain
 *     shares is one service), its source kept as an uploaded folder;
 *   - every domain attached to the service that serves its folder.
 *
 * Nothing here runs until somebody imports a backup. The scratch folder is
 * removed when the import ends, whether it worked or not. Something that cannot
 * be carried over (a domain another service already holds, a dump that will not
 * load) is reported as a warning instead of stopping the whole import; anything
 * that does stop it takes back what this import made (see `rollBackImport`).
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import * as deployService from "@/lib/deploy-service";
import * as databaseService from "@/lib/database-service";
import { NEW_ENVIRONMENT_NETWORK_MODE } from "@/lib/deploy/service-networks";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { restoreDumpInto } from "@/lib/database-ops/restore";
import { createReadStream, createWriteStream } from "node:fs";
import { storeSourceFolder } from "@/lib/deploy/source-upload";
import { getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { instanceContext, startOperation } from "@/lib/database-ops/ops";
import { inspectCpanelBackup, type CpanelPlan, type ImportDomain, type ImportWarning } from "./cpanel";

/** The port an imported site is served on: the PHP image a detected site builds
 *  into answers there. */
const SITE_PORT = 80;

/** A database name the engine takes as it is; anything else gets one made from it. */
const SQL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export interface CpanelImportInput {
    /** The uploaded `.tar.gz`, already on disk. Left in place; the caller removes it. */
    readonly archive: string;
    readonly ownerId: string;
    readonly orgId: string | null;
    readonly actorId: string;
}

export interface CpanelImportResult {
    readonly projectId: string;
    readonly services: number;
    readonly databases: number;
    readonly domains: string[];
    readonly warnings: ImportWarning[];
}

/** Where an import is, for whoever watches it. */
export type ImportStep = "unpacking" | "databases" | "sites" | "finishing";
export type ImportReporter = (step: ImportStep, done: number, total: number) => Promise<void>;

/** What one import has made so far, for taking it back when it fails. */
export interface MadeByImport {
    projectId: string | null;
    readonly applications: string[];
    /** In the order made: an instance before the databases inside it. */
    readonly databases: string[];
}

/** What is in the project now, whoever put it there. */
export interface ProjectContents {
    readonly environments: number;
    readonly applications: readonly string[];
    readonly databases: readonly string[];
}

/** Whether the whole project can go, or only what the import made: anything in it
 *  the import did not make (somebody added a service while it ran) keeps it. */
export function rollbackScope(made: MadeByImport, present: ProjectContents): "project" | "own" {
    const ours = (ids: readonly string[], own: readonly string[]) => ids.every((id) => own.includes(id));
    return present.environments <= 1 && ours(present.applications, made.applications) && ours(present.databases, made.databases)
        ? "project"
        : "own";
}

/** Take back what a failed import made. Each removal is tried on its own and
 *  logged when it fails: an import that failed is reported as failed either way. */
export async function rollBackImport(made: MadeByImport, ownerId: string): Promise<void> {
    const { projectId } = made;
    if (!projectId) return;
    const inProject = { environment: { projectId } };
    const [environments, applications, databases] = await Promise.all([
        prisma.environment.count({ where: { projectId } }),
        prisma.application.findMany({ where: inProject, select: { id: true } }),
        prisma.managedDatabase.findMany({ where: inProject, select: { id: true } })
    ]);
    const present = {
        environments,
        applications: applications.map((row) => row.id),
        databases: databases.map((row) => row.id)
    };
    const attempt = (what: string, run: () => Promise<unknown>) =>
        run().catch((error: unknown) => console.error(`panel-import: could not take back ${what}:`, error));
    if (rollbackScope(made, present) === "project") {
        await attempt(`project ${projectId}`, () => deployService.deleteProject(projectId, ownerId));
        return;
    }
    for (const id of made.applications) {
        await attempt(`service ${id}`, () => deployService.deleteApplication(id, ownerId, { deleteData: true }));
    }
    // The databases inside the instance first, the instance last.
    for (const id of [...made.databases].reverse()) {
        await attempt(`database ${id}`, () => databaseService.deleteDatabase(id, ownerId));
    }
}

/** One service to make: a folder in the home and the domains it serves. */
export interface SiteFolder {
    readonly documentRoot: string;
    readonly domains: ImportDomain[];
}

/** The plan's domains grouped by the folder they serve, the main domain's first. */
export function siteFolders(plan: CpanelPlan): SiteFolder[] {
    const byRoot = new Map<string, ImportDomain[]>();
    for (const domain of plan.domains) {
        const list = byRoot.get(domain.documentRoot) ?? [];
        list.push(domain);
        byRoot.set(domain.documentRoot, list);
    }
    // No domains read: the main site's folder still comes over, to be given one after.
    if (byRoot.size === 0) return plan.hasHome ? [{ documentRoot: "public_html", domains: [] }] : [];
    return [...byRoot.entries()].map(([documentRoot, domains]) => ({ documentRoot, domains }));
}

/** A project under this name, or "name 2", "name 3"... when the owner already has
 *  one by it (a backup imported twice). Closed to other projects, like one made
 *  from the Deploy screen. */
async function createFreshProject(ownerId: string, name: string, orgId: string | null) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            const named = attempt === 1 ? name : `${name} ${attempt}`;
            return await deployService.createProject(ownerId, named, orgId, NEW_ENVIRONMENT_NETWORK_MODE);
        } catch (error) {
            const taken = (error as { code?: unknown } | null)?.code === "P2002";
            if (!taken || attempt >= 20) throw error;
        }
    }
}

/** How many files a folder holds and what they weigh. Links are not followed. */
async function countFolder(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        files += 1;
        bytes += (await lstat(join(entry.parentPath, entry.name))).size;
    }
    return { files, bytes };
}

async function isFolder(path: string): Promise<boolean> {
    return stat(path).then(
        (info) => info.isDirectory(),
        () => false
    );
}

/** Load one plain `.sql` dump into a deployed database through the restore path,
 *  which takes a gzipped dump. */
async function loadDump(databaseId: string, ownerId: string, actorId: string, dump: string): Promise<void> {
    const gzipped = `${dump}.gz`;
    await pipeline(createReadStream(dump), createGzip(), createWriteStream(gzipped));
    try {
        const context = await instanceContext(databaseId, ownerId);
        const operation = await startOperation(databaseId, "restore", actorId);
        try {
            await restoreDumpInto(context, { local: gzipped }, { operation });
            await operation.succeed();
        } catch (error) {
            throw new Error(await operation.fail(error));
        }
    } finally {
        await rm(gzipped, { force: true });
    }
}

/** Import a checked backup as a new project. See the module comment. */
export async function importCpanelBackup(
    input: CpanelImportInput,
    report: ImportReporter = async () => undefined
): Promise<CpanelImportResult> {
    await report("unpacking", 0, 0);
    const { dir, root, plan } = await inspectCpanelBackup(input.archive);
    const made: MadeByImport = { projectId: null, applications: [], databases: [] };
    try {
        const { ownerId, actorId } = input;
        const warnings = [...plan.warnings];
        const primary = plan.domains.find((domain) => domain.primary)?.name;
        const project = await createFreshProject(ownerId, primary ?? plan.account ?? "Imported site", input.orgId);
        made.projectId = project.id;
        const environmentId = project.environments[0]?.id;
        if (!environmentId) throw new Error("The new project has no environment");
        const target = await getOrCreateLocalTarget(ownerId);

        let databases = 0;
        let instanceId: string | undefined;
        for (const [index, database] of plan.databases.entries()) {
            await report("databases", index, plan.databases.length);
            try {
                const created = await databaseService.createDatabase(ownerId, {
                    environmentId,
                    targetId: target.id,
                    name: database.name,
                    engine: "mysql",
                    privileges: "owner",
                    ...(SQL_IDENTIFIER.test(database.name) ? { databaseName: database.name } : {}),
                    ...(instanceId ? { instanceId } : {})
                });
                made.databases.push(created.id);
                const failed = await databaseService.deployDatabaseAndWait(created.id, ownerId, actorId);
                if (failed) throw new Error(failed);
                instanceId ??= created.id;
                await loadDump(created.id, ownerId, actorId, join(root, ...database.dump.split("/")));
                databases += 1;
            } catch (error) {
                console.error(`panel-import: database ${database.name} was not carried over:`, error);
                warnings.push({ code: "databaseFailed", name: database.name });
            }
        }

        let services = 0;
        const domains: string[] = [];
        const sites = siteFolders(plan);
        for (const [index, site] of sites.entries()) {
            await report("sites", index, sites.length);
            const folder = join(root, "homedir", ...site.documentRoot.split("/").filter(Boolean));
            const name = site.domains[0]?.name ?? (site.documentRoot || "site");
            if (!(await isFolder(folder))) {
                warnings.push({ code: "folderMissing", name });
                continue;
            }
            const application = await deployService.createApplication(ownerId, {
                environmentId,
                targetId: target.id,
                name,
                sourceType: "nixpacks",
                sourceConfig: { port: SITE_PORT },
                publishPort: false,
                safeHeaders: true
            });
            made.applications.push(application.id);
            await storeSourceFolder(application.id, ownerId, folder, name, await countFolder(folder));
            services += 1;
            for (const domain of site.domains) {
                try {
                    domains.push(
                        await deployService.addApplicationDomain(application.id, ownerId, { hostname: domain.name, targetPort: SITE_PORT })
                    );
                } catch (error) {
                    console.error(`panel-import: domain ${domain.name} was not attached:`, error);
                    warnings.push({ code: "domainTaken", name: domain.name });
                }
            }
            await deployService.deployApplication(application.id, ownerId, actorId, { trigger: "upload" }).catch((error: unknown) => {
                console.error(`panel-import: service ${application.id} did not start deploying:`, error);
                warnings.push({ code: "notDeploying", name });
            });
        }
        await report("finishing", sites.length, sites.length);
        return { projectId: project.id, services, databases, domains, warnings };
    } catch (error) {
        await rollBackImport(made, input.ownerId);
        throw error;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
