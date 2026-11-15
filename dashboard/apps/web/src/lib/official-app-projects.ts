/**
 * The compose projects of official apps' containers, for `isPolarisPart`.
 *
 * An official app that runs a container - the VPN's control server, the DNS
 * blocker's resolver, Places' camera hub, the mail server - is deployed into the
 * Marketplace project like anything installed, so the container looks exactly
 * like a service somebody deployed: `polaris-<hash of the service>`. What makes
 * it Polaris is the install row behind it and the app that row belongs to, so
 * that is what is read. A game server is the one exception: the Game servers app
 * is Polaris's, but each server is a world somebody made, and it stays theirs.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { shortHash } from "@polaris/deploy";
import { isGameServersApp } from "@polaris/core";
import { findApp, isGameServerApp } from "@/lib/apps/catalog";
import { storeScope } from "@/lib/apps/marketplace-store";
import { MAIL_SERVER_APP_ID, owningAppId } from "@/lib/deploy/managed-projects";
import type { OfficialApp, OfficialProjects } from "@/lib/polaris-parts";

/** The official app an install of this catalog id belongs to, or null when the
 *  install is the operator's own (a community app, a game server). Pure. */
export function officialOwner(catalogId: string): string | null {
    if (isGameServerApp(catalogId)) return null;
    const owner = owningAppId(catalogId);
    const manifest = findApp(owner);
    if (!manifest || isGameServersApp(owner)) return null;
    return storeScope(manifest) === "polaris" ? owner : null;
}

/** The compose project a deployed service runs under. */
function projectOf(applicationId: string): string {
    return `polaris-${shortHash(applicationId, 8)}`;
}

/** Every official app's project. Two indexed reads, whatever the instance's size. */
export async function officialAppProjects(): Promise<OfficialProjects> {
    const [installs, mail] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { not: null }, status: { not: "removed" } },
            select: { applicationId: true, catalogId: true }
        }),
        prisma.mailServer.findMany({
            where: { applicationId: { not: null } },
            select: { applicationId: true }
        })
    ]);
    const projects = new Map<string, OfficialApp>();
    for (const row of installs) {
        const owner = officialOwner(row.catalogId);
        if (owner && row.applicationId)
            projects.set(projectOf(row.applicationId), { owner, install: row.catalogId });
    }
    for (const row of mail) {
        if (row.applicationId)
            projects.set(projectOf(row.applicationId), {
                owner: MAIL_SERVER_APP_ID,
                install: MAIL_SERVER_APP_ID
            });
    }
    return projects;
}

/** The same, or none when the database cannot be read: a screen still splits the
 *  stack from the rest, and only official apps fall back to "your apps". */
export async function officialAppProjectsOrNone(): Promise<OfficialProjects> {
    return officialAppProjects().catch(() => new Map());
}
