/**
 * What a project's frame says about each environment without opening it: where
 * its services answer, how its last deploy went, and which services need a look.
 *
 * Read by the project layout, so it is a handful of indexed queries for the whole
 * project and never a probe of its own - the health and deploy states it reports
 * are the ones the probe and the pipeline already wrote.
 */

import { prisma } from "@polaris/db";
import { projectAccess } from "../deploy-project-access";
import { listActiveTunnelDomains } from "./tunnel-domains";
import {
    FAILED_CRON_STATUSES,
    FAILED_DEPLOY_STATUSES,
    attentionReasons,
    type ServiceAttention
} from "./attention";

/** Where one of the environment's services answers. */
export interface GlanceAddress {
    id: string;
    hostname: string;
    kind: string;
    enabled: boolean;
    healthStatus?: string;
    /** The service it belongs to. */
    applicationId: string;
    service: string;
}

export interface EnvironmentGlance {
    /** Every address of every service, unranked - the view picks the best. */
    addresses: GlanceAddress[];
    /** The newest deployment of any of its services. */
    lastDeploy: {
        applicationId: string;
        service: string;
        status: string;
        createdAt: string;
    } | null;
    /** Services that need a look, and why. */
    attention: { applicationId: string; service: string; reasons: string[] }[];
}

/** Whether each service needs a look (see `attention.ts`), three queries for all of them. */
export async function serviceAttention(
    appIds: readonly string[]
): Promise<Map<string, ServiceAttention>> {
    const result = new Map<string, ServiceAttention>();
    if (appIds.length === 0) return result;
    const ids = [...appIds];

    const [latest, down, crons] = await Promise.all([
        // The newest deployment of each service - one row each.
        prisma.deployment.findMany({
            where: { deployableType: "application", deployableId: { in: ids } },
            orderBy: { createdAt: "desc" },
            distinct: ["deployableId"],
            select: { deployableId: true, status: true }
        }),
        prisma.domain.findMany({
            where: {
                applicationId: { in: ids },
                enabled: true,
                kind: { not: "release" },
                healthStatus: "down"
            },
            select: { applicationId: true }
        }),
        prisma.serviceCron.findMany({
            where: {
                applicationId: { in: ids },
                enabled: true,
                lastStatus: { in: [...FAILED_CRON_STATUSES] }
            },
            select: { applicationId: true }
        })
    ]);

    for (const id of ids)
        result.set(id, { deployFailed: false, domainDown: false, cronFailing: false });
    for (const row of latest) {
        const entry = result.get(row.deployableId);
        if (entry && FAILED_DEPLOY_STATUSES.includes(row.status)) entry.deployFailed = true;
    }
    for (const row of down) {
        const entry = result.get(row.applicationId);
        if (entry) entry.domainDown = true;
    }
    for (const row of crons) {
        const entry = result.get(row.applicationId);
        if (entry) entry.cronFailing = true;
    }
    return result;
}

/**
 * The glance for every environment of a project this reader reaches, and none
 * of the others: an environment they are kept out of does not have its addresses
 * sent to their browser either. Empty when they reach nothing.
 */
export async function readerProjectGlance(
    projectId: string,
    userId: string
): Promise<Record<string, EnvironmentGlance>> {
    const access = await projectAccess(projectId, userId);
    if (!access) return {};
    const environments = await prisma.environment.findMany({
        where: {
            projectId,
            ...(access.environmentIds !== null ? { id: { in: [...access.environmentIds] } } : {})
        },
        select: { id: true, applications: { select: { id: true, name: true } } }
    });
    return projectGlance(environments);
}

/** The glance for each of the given environments, keyed by environment id. */
export async function projectGlance(
    environments: readonly { id: string; applications: readonly { id: string; name: string }[] }[]
): Promise<Record<string, EnvironmentGlance>> {
    const apps = environments.flatMap((environment) =>
        environment.applications.map((app) => ({ ...app, environmentId: environment.id }))
    );
    const ids = apps.map((app) => app.id);
    const names = new Map(apps.map((app) => [app.id, app.name]));

    const [domains, tunnels, latest, attention] = await Promise.all([
        ids.length
            ? prisma.domain.findMany({
                  where: { applicationId: { in: ids }, kind: { not: "release" } },
                  orderBy: { createdAt: "asc" },
                  select: {
                      id: true,
                      applicationId: true,
                      hostname: true,
                      kind: true,
                      enabled: true,
                      healthStatus: true
                  }
              })
            : [],
        listActiveTunnelDomains(ids),
        ids.length
            ? prisma.deployment.findMany({
                  where: { deployableType: "application", deployableId: { in: ids } },
                  orderBy: { createdAt: "desc" },
                  distinct: ["deployableId"],
                  select: { deployableId: true, status: true, createdAt: true }
              })
            : [],
        serviceAttention(ids)
    ]);

    const glance: Record<string, EnvironmentGlance> = {};
    for (const environment of environments)
        glance[environment.id] = { addresses: [], lastDeploy: null, attention: [] };
    const environmentOf = new Map(apps.map((app) => [app.id, app.environmentId]));

    for (const domain of domains) {
        const target = glance[environmentOf.get(domain.applicationId) ?? ""];
        target?.addresses.push({ ...domain, service: names.get(domain.applicationId) ?? "" });
    }
    for (const [applicationId, list] of tunnels) {
        const target = glance[environmentOf.get(applicationId) ?? ""];
        if (!target) continue;
        const seen = new Set(target.addresses.map((address) => address.hostname.toLowerCase()));
        for (const tunnel of list) {
            if (seen.has(tunnel.hostname)) continue;
            target.addresses.push({
                id: tunnel.id,
                hostname: tunnel.hostname,
                kind: tunnel.kind,
                enabled: tunnel.enabled,
                applicationId,
                service: names.get(applicationId) ?? ""
            });
        }
    }
    for (const row of latest) {
        const target = glance[environmentOf.get(row.deployableId) ?? ""];
        if (!target) continue;
        if (target.lastDeploy && target.lastDeploy.createdAt >= row.createdAt.toISOString())
            continue;
        target.lastDeploy = {
            applicationId: row.deployableId,
            service: names.get(row.deployableId) ?? "",
            status: row.status,
            createdAt: row.createdAt.toISOString()
        };
    }
    for (const app of apps) {
        const reasons = attentionReasons(attention.get(app.id));
        if (reasons.length > 0)
            glance[app.environmentId]?.attention.push({
                applicationId: app.id,
                service: app.name,
                reasons
            });
    }
    return glance;
}
