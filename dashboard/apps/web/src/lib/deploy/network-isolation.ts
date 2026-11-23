/**
 * Closing the environments made before private networking existed.
 *
 * Every environment from before then sits on the one network the whole machine
 * shares, so any service can reach any other project's by name. New ones are made
 * closed (`NEW_ENVIRONMENT_NETWORK_MODE`), but a stored choice is never flipped
 * behind the operator's back: moving a service to another network means starting
 * it again. So this is offered once per owner, with the list of what restarts,
 * and done when they say so.
 *
 * Two kinds of environment are on that list:
 *
 * - `isolate`: still `shared`. It becomes `environment`, and everything running in
 *   it starts again - databases first, so a service never comes up on a network
 *   its database is not on yet.
 * - `restart`: already private, but a routed service in it was started while a
 *   routed service still joined the shared proxy network as well. Starting it again
 *   takes it off.
 *
 * The projects Polaris runs for its installed apps never appear: their stack's
 * own routers dial those services on the shared network.
 */

import { prisma } from "@polaris/db";
import { getCapabilities } from "@polaris/config";
import { getSetting, setSetting, swapSetting } from "@/lib/setting-store";
import { polarisProjectIds } from "@/lib/deploy/managed-projects";

/** At most this many environments are offered at once; the rest come next time. */
export const ISOLATION_ENVIRONMENT_LIMIT = 50;
/** At most this many names are listed per environment; the rest are counted. */
export const ISOLATION_NAME_LIMIT = 8;

/** A database counts as running in any of these states. */
const RUNNING_DATABASE_STATES = ["running", "active", "healthy", "ready"];

/** Where the owner's answer is kept, so the offer is made once. */
export function isolationSettingKey(ownerId: string): string {
    return `deploy.networkIsolation.${ownerId}`;
}

export type IsolationChange = "isolate" | "restart";

export interface IsolationEnvironment {
    readonly id: string;
    readonly name: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly change: IsolationChange;
    /** The services and databases that start again, at most `ISOLATION_NAME_LIMIT`. */
    readonly restarts: readonly string[];
    /** How many more start again than `restarts` names. */
    readonly moreRestarts: number;
}

export interface IsolationReview {
    readonly environments: readonly IsolationEnvironment[];
    /** Whether there were more environments than `ISOLATION_ENVIRONMENT_LIMIT`. */
    readonly truncated: boolean;
    /** Whether this machine can hold private networks at all. */
    readonly capable: boolean;
    /** When the owner answered, or null while the offer stands. */
    readonly settledAt: string | null;
}

const runningApp = { currentDeploymentId: { not: null } } as const;
const routedApp = { ...runningApp, domains: { some: { enabled: true } } } as const;
const runningDatabase = {
    parentId: null,
    provider: "",
    status: { in: RUNNING_DATABASE_STATES }
} as const;

/** The environments that would change, and what in each starts again. */
export async function reviewNetworkIsolation(ownerId: string): Promise<IsolationReview> {
    const settledAt = await getSetting(isolationSettingKey(ownerId));
    const capable = getCapabilities().privateNetworks;
    if (settledAt) return { environments: [], truncated: false, capable, settledAt };
    const hidden = await polarisProjectIds();

    const rows = await prisma.environment.findMany({
        where: {
            project: { ownerId, id: { notIn: [...hidden] } },
            OR: [
                { networkMode: "shared" },
                { networkMode: { not: "shared" }, applications: { some: routedApp } }
            ]
        },
        orderBy: [{ project: { name: "asc" } }, { createdAt: "asc" }],
        take: ISOLATION_ENVIRONMENT_LIMIT + 1,
        select: {
            id: true,
            name: true,
            networkMode: true,
            project: { select: { id: true, name: true } },
            databases: {
                where: runningDatabase,
                orderBy: { createdAt: "asc" },
                take: ISOLATION_NAME_LIMIT,
                select: { name: true }
            },
            applications: {
                where: runningApp,
                orderBy: { createdAt: "asc" },
                take: ISOLATION_NAME_LIMIT,
                select: { name: true }
            },
            _count: {
                select: {
                    databases: { where: runningDatabase },
                    applications: { where: runningApp }
                }
            }
        }
    });
    // A private environment restarts only its routed services; their names and
    // count come from a second read over just those few environments.
    const privateIds = rows.filter((row) => row.networkMode !== "shared").map((row) => row.id);
    const routed = privateIds.length
        ? await prisma.environment.findMany({
              where: { id: { in: privateIds } },
              select: {
                  id: true,
                  applications: {
                      where: routedApp,
                      orderBy: { createdAt: "asc" },
                      take: ISOLATION_NAME_LIMIT,
                      select: { name: true }
                  },
                  _count: { select: { applications: { where: routedApp } } }
              }
          })
        : [];
    const routedById = new Map(routed.map((row) => [row.id, row]));

    const environments = rows.slice(0, ISOLATION_ENVIRONMENT_LIMIT).map((row) => {
        const base = { id: row.id, name: row.name, projectId: row.project.id, projectName: row.project.name };
        if (row.networkMode === "shared") {
            const names = [...row.databases, ...row.applications].map((one) => one.name);
            const total = row._count.databases + row._count.applications;
            const restarts = names.slice(0, ISOLATION_NAME_LIMIT);
            return { ...base, change: "isolate" as const, restarts, moreRestarts: total - restarts.length };
        }
        const own = routedById.get(row.id);
        const restarts = (own?.applications ?? []).map((one) => one.name);
        const total = own?._count.applications ?? restarts.length;
        return { ...base, change: "restart" as const, restarts, moreRestarts: total - restarts.length };
    });
    return {
        environments,
        truncated: rows.length > ISOLATION_ENVIRONMENT_LIMIT,
        capable,
        settledAt: null
    };
}

/** What one environment needs done, read again at the moment it is done. */
export interface IsolationPlan {
    readonly environmentId: string;
    readonly projectId: string;
    readonly change: IsolationChange;
    readonly from: string;
    /** Running databases, in the order they start: none for `restart`. */
    readonly databaseIds: readonly string[];
    /** Running services: every one for `isolate`, the routed ones for `restart`. */
    readonly applicationIds: readonly string[];
}

/**
 * Switch the chosen environments and say what has to start again in each.
 *
 * Only environments that are still on the review are touched, whatever the
 * caller sent, so nothing restarts that the owner was not shown. Answers null
 * when the offer was already taken - a second click, another tab - and then
 * changes nothing.
 */
export async function applyNetworkIsolation(
    ownerId: string,
    environmentIds: readonly string[]
): Promise<IsolationPlan[] | null> {
    const review = await reviewNetworkIsolation(ownerId);
    if (review.settledAt) return null;
    if (!review.capable) throw new Error("This machine cannot hold private networks yet");
    const chosen = new Set(environmentIds);
    const offered = review.environments.filter((environment) => chosen.has(environment.id));
    if (!(await swapSetting(isolationSettingKey(ownerId), null, new Date().toISOString())))
        return null;

    try {
        return await switchEnvironments(ownerId, offered);
    } catch (caught) {
        // Nothing restarts on a failed switch, so the offer stands again.
        await setSetting(isolationSettingKey(ownerId), null).catch(() => undefined);
        throw caught;
    }
}

async function switchEnvironments(
    ownerId: string,
    offered: readonly IsolationEnvironment[]
): Promise<IsolationPlan[]> {
    const plans: IsolationPlan[] = [];
    for (const environment of offered) {
        const row = await prisma.environment.findFirst({
            where: { id: environment.id, project: { ownerId } },
            select: {
                networkMode: true,
                databases: {
                    where: runningDatabase,
                    orderBy: { createdAt: "asc" },
                    select: { id: true }
                },
                applications: {
                    where: environment.change === "isolate" ? runningApp : routedApp,
                    orderBy: { createdAt: "asc" },
                    select: { id: true }
                }
            }
        });
        if (!row) continue;
        const isolate = row.networkMode === "shared";
        if (isolate) {
            await prisma.environment.update({
                where: { id: environment.id },
                data: { networkMode: "environment" }
            });
        }
        plans.push({
            environmentId: environment.id,
            projectId: environment.projectId,
            change: isolate ? "isolate" : "restart",
            from: row.networkMode,
            databaseIds: isolate ? row.databases.map((one) => one.id) : [],
            applicationIds: row.applications.map((one) => one.id)
        });
    }
    return plans;
}

/** Keep every environment as it is, and stop offering. */
export async function keepNetworksAsTheyAre(ownerId: string): Promise<void> {
    await swapSetting(isolationSettingKey(ownerId), null, new Date().toISOString());
}

/**
 * Start everything in the plans again, one environment at a time: its databases
 * first, each waited on, then its services from their kept images. A failure
 * is logged and the rest carry on - a service that did not restart moves on its
 * next deploy, as every service does.
 */
export async function restartForIsolation(
    plans: readonly IsolationPlan[],
    ownerId: string,
    actorId: string
): Promise<void> {
    const [{ deployDatabaseAndWait }, { restartFromKeptImage }] = await Promise.all([
        import("@/lib/database-service"),
        import("@/lib/deploy-service")
    ]);
    for (const plan of plans) {
        for (const databaseId of plan.databaseIds) {
            const failed = await deployDatabaseAndWait(databaseId, ownerId, actorId);
            if (failed) console.error(`polaris: database ${databaseId} did not restart onto its network: ${failed}`);
        }
        for (const applicationId of plan.applicationIds) {
            await restartFromKeptImage(applicationId, ownerId, actorId, "settings", {
                reason: "isolation"
            }).catch((error) =>
                console.error(`polaris: service ${applicationId} did not restart onto its network:`, error)
            );
        }
    }
}
