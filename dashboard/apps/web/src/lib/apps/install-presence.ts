/**
 * Whether this Polaris has a marketplace app at all, for the parts of the shell
 * that are drawn before anybody asks for the app itself.
 *
 * An app whose whole surface is a top-level entry in the switcher should not be
 * an entry until somebody installs it: a door onto an empty room is worse than no
 * door. The switcher is rendered on every screen, so the answer is cached for a
 * few seconds and dropped the moment an install or an uninstall changes it -
 * otherwise every navigation pays a query to be told the same thing.
 *
 * Instance-wide rather than per owner. The apps this gates (Home) are one per
 * Polaris, and everybody who holds their permission is looking at the same one.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";

const CACHE_TTL_MS = 15_000;

const cache = new Map<string, { present: boolean; at: number }>();

/** Whether any non-removed install of this catalog app exists. */
export async function isAppInstalled(catalogId: string): Promise<boolean> {
    const hit = cache.get(catalogId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.present;
    const row = await prisma.installedApp.findFirst({
        where: { catalogId, status: { not: "removed" } },
        select: { id: true }
    });
    const present = row !== null;
    cache.set(catalogId, { present, at: Date.now() });
    return present;
}

/** Forget what was cached, so an install or an uninstall shows up at once rather
 *  than at the end of the TTL. Called with no argument it forgets everything. */
export function invalidateInstallPresence(catalogId?: string): void {
    if (catalogId) cache.delete(catalogId);
    else cache.clear();
}
