/**
 * The named things the signed-in user can jump to: deploy projects and their
 * services, servers, runner pools and installed apps.
 *
 * The whole index is returned rather than one query's matches, because it is
 * small (a name, a context line and an href each) and the palette then filters
 * it on every keystroke without touching the network. Every source is scoped to
 * the caller - by ownership in the list services, and by the same permission its
 * page requires - so nothing reaches the client that clicking it would refuse.
 * Node runtime for Prisma.
 */

import { listHosts } from "@/lib/host-service";
import { listProjects } from "@/lib/deploy-service";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import type { SearchResource } from "@/lib/search/entries";
import { requireUser, userHasManage } from "@/lib/session";
import { listInstalledApps } from "@/lib/apps/install-service";
import { listRunnerPools } from "@/lib/runners/runner-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ceiling per source, so a crowded account cannot turn this into a huge payload. */
const MAX_PER_SOURCE = 200;

export async function GET(): Promise<Response> {
    const user = await requireUser();
    const [canDeploy, canManage] = await Promise.all([
        userHasManage(user, "deploy.read"),
        userHasManage(user, "system.manage")
    ]);

    const resources: SearchResource[] = [];

    if (canDeploy) {
        // Search follows the shelf too: finding a client's service while working
        // on your own things is how you open the wrong one.
        const projects = await listProjects(user.id, await scopeOrgIdFor(user.id));
        for (const project of projects.slice(0, MAX_PER_SOURCE)) {
            const href = `/apps/deploy/${project.id}`;
            resources.push({
                id: project.id,
                kind: "project",
                label: project.name,
                context: "Deploy project",
                href
            });
            // Services have no route of their own, so they land on their project.
            for (const environment of project.environments) {
                const where = `${project.name} / ${environment.name}`;
                for (const application of environment.applications) {
                    resources.push({
                        id: application.id,
                        kind: "service",
                        label: application.name,
                        context: where,
                        href
                    });
                }
                for (const database of environment.databases) {
                    resources.push({
                        id: database.id,
                        kind: "database",
                        label: database.name,
                        context: `${database.engine} in ${where}`,
                        href
                    });
                }
            }
        }

        const installed = await listInstalledApps(user.id);
        for (const app of installed.slice(0, MAX_PER_SOURCE)) {
            resources.push({
                id: app.id,
                kind: "installed",
                label: app.name,
                context: `Installed app - ${app.status}`,
                href: `/apps/installed/${app.id}`
            });
        }
    }

    if (canManage) {
        const [hosts, pools] = await Promise.all([listHosts(user.id), listRunnerPools(user.id)]);
        for (const host of hosts.slice(0, MAX_PER_SOURCE)) {
            resources.push({
                id: host.id,
                kind: "server",
                label: host.name,
                context: `${host.username}@${host.address}`,
                href: "/apps/servers"
            });
        }
        for (const pool of pools.slice(0, MAX_PER_SOURCE)) {
            resources.push({
                id: pool.id,
                kind: "runner",
                label: pool.name,
                context: pool.scopeSummary,
                href: "/apps/runners"
            });
        }
    }

    return Response.json({ resources });
}
