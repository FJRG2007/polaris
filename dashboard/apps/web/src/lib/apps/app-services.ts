/**
 * The services Polaris runs for one of its apps, as that app's settings show them.
 *
 * These used to be reached from Deploy, inside the Marketplace project. Deploy no
 * longer lists them, so the app that owns them is where an administrator sees
 * whether they are up, what they use, what they print, and restarts one.
 *
 * Everything here reads; the only thing it does to a container is the restart
 * Deploy always offered - an in-place restart of the one container, which keeps
 * it, its volumes, its labels and its routes exactly as they are.
 */

import { prisma } from "@polaris/db";
import { readConsumption } from "@/lib/consumption-service";
import type { ConsumptionRow } from "@/app/(app)/admin/consumption/types";
import { getApplicationDeployStatuses, readAppRuntimeLog, restartApplication } from "@/lib/deploy-service";
import { MAIL_SERVER_APP_ID, owningAppId } from "@/lib/deploy/managed-projects";

/** One service of an app, as its settings list it. */
export interface AppService {
    readonly applicationId: string;
    readonly name: string;
    /** The install it backs, named the way its owner named it. Null for the mail server. */
    readonly installName: string | null;
    readonly status: string;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
}

/** What a service is, before anything about its container is read. */
interface ServiceRef {
    readonly applicationId: string;
    readonly installId: string | null;
    readonly installName: string | null;
}

/** The services backing this app's installs, plus the mail server's for that app. */
async function serviceRefs(appId: string): Promise<ServiceRef[]> {
    const [installs, mail] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { not: null }, status: { not: "removed" } },
            select: { id: true, name: true, catalogId: true, applicationId: true },
            orderBy: { createdAt: "asc" }
        }),
        appId === MAIL_SERVER_APP_ID
            ? prisma.mailServer.findMany({
                  where: { applicationId: { not: null } },
                  select: { applicationId: true }
              })
            : Promise.resolve([])
    ]);
    return [
        ...installs
            .filter((install) => owningAppId(install.catalogId) === appId)
            .map((install) => ({
                applicationId: install.applicationId as string,
                installId: install.id,
                installName: install.name
            })),
        ...mail.map((row) => ({
            applicationId: row.applicationId as string,
            installId: null,
            installName: null
        }))
    ];
}

/** Whether this app runs any service at all - what decides its Settings link. */
export async function appHasServices(appId: string): Promise<boolean> {
    return (await serviceRefs(appId)).length > 0;
}

/** Every figure a row of the consumption screen carries, by the id it is under. */
function usageById(rows: readonly ConsumptionRow[]): Map<string, ConsumptionRow> {
    const byId = new Map<string, ConsumptionRow>();
    for (const row of rows) {
        byId.set(row.id, row);
        for (const part of row.parts) byId.set(part.id, part);
    }
    return byId;
}

/** This app's services with their state and what they use right now. */
export async function listAppServices(appId: string, viewerId: string): Promise<AppService[]> {
    const refs = await serviceRefs(appId);
    if (refs.length === 0) return [];
    const applications = await prisma.application.findMany({
        where: { id: { in: refs.map((ref) => ref.applicationId) }, binnedAt: null },
        select: { id: true, name: true, currentDeploymentId: true }
    });
    const [statuses, consumption] = await Promise.all([
        getApplicationDeployStatuses(applications),
        // Figures are a nicety: a machine whose engine cannot be read still lists
        // its services and their state.
        readConsumption(viewerId).catch(() => null)
    ]);
    const usage = usageById(consumption?.groups.flatMap((group) => group.rows) ?? []);
    const byId = new Map(applications.map((application) => [application.id, application]));
    return refs.flatMap((ref) => {
        const application = byId.get(ref.applicationId);
        if (!application) return [];
        const figures = usage.get(ref.installId ?? ref.applicationId);
        return [
            {
                applicationId: application.id,
                name: application.name,
                installName: ref.installName,
                status: statuses[application.id] ?? "unknown",
                cpuPercent: figures?.cpuPercent ?? null,
                memUsedBytes: figures?.memUsedBytes ?? null
            }
        ];
    });
}

/**
 * Who owns this service, when it is one of this app's - what every runtime call
 * for it is made as. Null for a service that is not this app's, so the settings
 * of one app cannot reach another's, or a service somebody deployed.
 */
async function serviceOwner(appId: string, applicationId: string): Promise<string | null> {
    const refs = await serviceRefs(appId);
    if (!refs.some((ref) => ref.applicationId === applicationId)) return null;
    const application = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environment: { select: { project: { select: { ownerId: true } } } } }
    });
    return application?.environment.project.ownerId ?? null;
}

/** Restart one of this app's services, the way Deploy restarted it. False when it is not this app's. */
export async function restartAppService(appId: string, applicationId: string): Promise<boolean> {
    const ownerId = await serviceOwner(appId, applicationId);
    if (!ownerId) return false;
    await restartApplication(applicationId, ownerId);
    return true;
}

/**
 * What one of this app's services printed last. Read as the project's owner, so
 * any administrator sees it, not only the one who installed the app. Null when
 * it is not this app's.
 */
export async function readAppServiceLog(
    appId: string,
    applicationId: string,
    tail: number
): Promise<string | null> {
    const ownerId = await serviceOwner(appId, applicationId);
    if (!ownerId) return null;
    return readAppRuntimeLog(applicationId, ownerId, tail);
}
