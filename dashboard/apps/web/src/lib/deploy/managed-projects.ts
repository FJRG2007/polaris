/**
 * Which Deploy projects Polaris runs for itself.
 *
 * Two kinds of project appear in Deploy without anybody having made them there:
 * the "Marketplace" project every installed app is deployed into, and a project
 * holding only services Polaris set up to run part of itself - its mail server.
 * On an instance with a few installs, those crowd out the projects the operator
 * actually builds, so the list keeps them behind a switch.
 *
 * Deciding it is a read of what backs each service, never a name: a project the
 * operator happened to call "Mail" is theirs.
 */

import { prisma } from "@polaris/db";

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
