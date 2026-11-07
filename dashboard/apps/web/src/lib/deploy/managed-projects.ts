/**
 * Which Deploy projects Polaris runs for itself.
 *
 * Two kinds of project appear in Deploy without anybody having made them there:
 * the "Marketplace" project every installed app is deployed into, and a project
 * holding only services Polaris set up to run part of itself - its mail server.
 * Deploy lists only what people deployed, so every reader that shows projects to
 * somebody leaves these out; their services are reached from the app that runs
 * them, under Polaris apps > <the app> > Settings.
 *
 * The rows themselves stay exactly as they are. Everything that keeps those
 * services running - routes, the health probe, the boot reconcile, the sweeps -
 * reads applications directly, never through a listing, so hiding a project here
 * changes what is shown and nothing that is run.
 *
 * Deciding it is a read of what backs each service, never a name: a project the
 * operator happened to call "Mail" is theirs.
 */

import { prisma } from "@polaris/db";
import { findApp } from "@/lib/apps/catalog";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { POLARIS_APPS_PATH } from "@/lib/apps/marketplace-store";

/** The slug of the project marketplace installs are deployed into. Owned here
 *  because both the installer and the list need it. */
export const MARKETPLACE_PROJECT_SLUG = "marketplace";

/** What the rule reads about one project. */
export interface ProjectShape {
    readonly slug: string;
    readonly applicationIds: readonly string[];
    readonly databaseCount: number;
}

/**
 * Whether Polaris runs this project for itself.
 *
 * The Marketplace project always is. Any other one is only when every service in
 * it backs something Polaris installed, and it holds nothing else - a project
 * where the operator added a service of their own beside it is theirs.
 */
export function isManagedProject(project: ProjectShape, managed: ReadonlySet<string>): boolean {
    if (project.slug === MARKETPLACE_PROJECT_SLUG) return true;
    if (project.applicationIds.length === 0 || project.databaseCount > 0) return false;
    return project.applicationIds.every((id) => managed.has(id));
}

/**
 * The services among these that back something Polaris installed: a
 * marketplace app or the mail server. Two indexed reads, whatever the count.
 */
export async function polarisManagedApplications(
    applicationIds: readonly string[]
): Promise<Set<string>> {
    if (applicationIds.length === 0) return new Set();
    const ids = [...new Set(applicationIds)];
    const [installs, mail] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { in: ids } },
            select: { applicationId: true }
        }),
        prisma.mailServer.findMany({
            where: { applicationId: { in: ids } },
            select: { applicationId: true }
        })
    ]);
    return new Set(
        [...installs, ...mail]
            .map((row) => row.applicationId)
            .filter((id): id is string => id !== null)
    );
}

/** The app the mail server's services belong to. */
export const MAIL_SERVER_APP_ID = "mail-server";

/** The app an install belongs to: a game server is the Game servers app's, a
 *  camera relay is Places'; anything else is its own app. */
export function owningAppId(catalogId: string): string {
    return findApp(catalogId)?.ownedBy ?? catalogId;
}

/**
 * The projects no Deploy listing shows: every Marketplace project, and every one
 * holding nothing but services Polaris set up. Three indexed reads plus one over
 * the few projects that hold such a service, whatever the instance's size.
 */
export async function polarisProjectIds(): Promise<Set<string>> {
    const [marketplace, installs, mail] = await Promise.all([
        prisma.project.findMany({
            where: { slug: MARKETPLACE_PROJECT_SLUG },
            select: { id: true }
        }),
        prisma.installedApp.findMany({
            where: { applicationId: { not: null } },
            select: { applicationId: true }
        }),
        prisma.mailServer.findMany({
            where: { applicationId: { not: null } },
            select: { applicationId: true }
        })
    ]);
    const hidden = new Set(marketplace.map((project) => project.id));
    const managed = new Set(
        [...installs, ...mail]
            .map((row) => row.applicationId)
            .filter((id): id is string => id !== null)
    );
    if (managed.size === 0) return hidden;
    const candidates = await prisma.project.findMany({
        where: {
            id: { notIn: [...hidden] },
            environments: { some: { applications: { some: { id: { in: [...managed] } } } } }
        },
        select: {
            id: true,
            slug: true,
            environments: {
                select: {
                    applications: { where: { binnedAt: null }, select: { id: true } },
                    databases: { where: { binnedAt: null }, select: { id: true } }
                }
            }
        }
    });
    for (const project of candidates) {
        const shape = {
            slug: project.slug,
            applicationIds: project.environments.flatMap((one) =>
                one.applications.map((app) => app.id)
            ),
            databaseCount: project.environments.reduce((sum, one) => sum + one.databases.length, 0)
        };
        if (isManagedProject(shape, managed)) hidden.add(project.id);
    }
    return hidden;
}

/** The app each of these services belongs to, for those Polaris set up. */
export async function owningApps(applicationIds: readonly string[]): Promise<Map<string, string>> {
    if (applicationIds.length === 0) return new Map();
    const ids = [...new Set(applicationIds)];
    const [installs, mail] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { in: ids } },
            select: { applicationId: true, catalogId: true }
        }),
        prisma.mailServer.findMany({
            where: { applicationId: { in: ids } },
            select: { applicationId: true }
        })
    ]);
    const owners = new Map<string, string>();
    for (const row of installs) {
        if (row.applicationId) owners.set(row.applicationId, owningAppId(row.catalogId));
    }
    for (const row of mail) {
        if (row.applicationId) owners.set(row.applicationId, MAIL_SERVER_APP_ID);
    }
    return owners;
}

/**
 * Where a Deploy address into one of these projects goes instead: the settings of
 * the app that runs the service (or the project's only app), else the Polaris
 * apps list. Null for a project somebody deployed, which opens as it always did.
 * Only an address is decided here; the settings page asks for an administrator
 * itself, so nobody else is shown anything by following it.
 */
export async function polarisProjectRedirect(
    projectId: string,
    serviceId?: string | null
): Promise<string | null> {
    if (!(await polarisProjectIds()).has(projectId)) return null;
    const services = await prisma.application.findMany({
        where: { environment: { projectId }, ...(serviceId ? { id: serviceId } : {}) },
        select: { id: true }
    });
    const apps = new Set((await owningApps(services.map((service) => service.id))).values());
    const [only] = apps;
    return apps.size === 1 && only ? appSettingsPath(only) : POLARIS_APPS_PATH;
}
