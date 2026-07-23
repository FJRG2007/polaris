/**
 * Installing a marketplace app is a thin orchestration over Deploy: it resolves
 * the chosen server (a DeployTarget), creates a Deploy Application from the
 * manifest's compose template, wires the operator's env and storage choices, and
 * records an InstalledApp row linking the two. No new runtime - the container is
 * built, deployed and managed by the same engine as any deployed app.
 */

import { prisma } from "@polaris/db";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { listHosts } from "@/lib/host-service";
import { createApplication, createProject, deployApplication } from "@/lib/deploy-service";
import { createVolume } from "@/lib/deploy-volume-service";
import { setEnvVars } from "@/lib/env-var-service";
import { findApp, isInstallable } from "@/lib/apps/catalog";
import type { AppInstallInput } from "@/lib/apps/install-schema";

/** All marketplace installs live under one project per owner, so the Deploy
 *  canvas stays uncluttered and the apps share a default environment. */
const MARKETPLACE_PROJECT = "Marketplace";

export interface InstalledAppView {
    id: string;
    catalogId: string;
    name: string;
    status: string;
    applicationId: string | null;
    targetId: string | null;
    createdAt: string;
}

/** The owner's Marketplace environment id, creating the project on first use. */
async function ensureMarketplaceEnvironment(ownerId: string): Promise<string> {
    const existing = await prisma.project.findFirst({
        where: { ownerId, slug: "marketplace" },
        include: { environments: { orderBy: { isDefault: "desc" }, take: 1 } }
    });
    const current = existing?.environments[0];
    if (current) return current.id;
    const created = await createProject(ownerId, MARKETPLACE_PROJECT);
    const environment = created.environments[0];
    if (!environment) throw new Error("Could not create the Marketplace environment");
    return environment.id;
}

/** Install a catalog app: create and deploy its stack, then record the install. */
export async function installApp(
    ownerId: string,
    actorId: string,
    input: AppInstallInput
): Promise<{ installedAppId: string; applicationId: string }> {
    const app = findApp(input.catalogId);
    if (!app) throw new Error("Unknown app");
    if (!isInstallable(app)) throw new Error("This app cannot be installed yet");
    // isInstallable guarantees a compose template with an image.
    const template = app.template!;
    const image = template.image!;

    if (app.singleton) {
        const existing = await prisma.installedApp.findFirst({
            where: { ownerId, catalogId: app.id, status: { not: "removed" } }
        });
        if (existing) throw new Error("This app is already installed");
    }

    // Resolve the server the operator chose: the local host, or an SSH host
    // adopted as a deploy target on first use (same path as Deploy).
    const target =
        input.serverId === "local"
            ? await getOrCreateLocalTarget(ownerId)
            : await (async () => {
                  const host = (await listHosts(ownerId)).find((item) => item.id === input.serverId);
                  if (!host) throw new Error("The selected server was not found");
                  return getOrCreateHostTarget(host.id, ownerId, host.name);
              })();

    const environmentId = await ensureMarketplaceEnvironment(ownerId);
    const primaryPort = template.ports?.[0]?.container;
    const application = await createApplication(ownerId, {
        environmentId,
        targetId: target.id,
        name: input.name,
        sourceType: "image",
        sourceConfig: { imageRef: image, ...(primaryPort ? { port: primaryPort } : {}) }
    });

    // Env: manifest defaults overlaid with the operator's values, preserving each
    // var's secret flag so secrets are stored encrypted.
    const envByKey = new Map<string, { value: string; isSecret: boolean }>();
    for (const declared of template.env ?? []) {
        if (declared.default !== undefined) {
            envByKey.set(declared.key, { value: declared.default, isSecret: Boolean(declared.secret) });
        }
    }
    for (const entry of input.env) {
        const declared = template.env?.find((item) => item.key === entry.key);
        envByKey.set(entry.key, { value: entry.value, isSecret: Boolean(declared?.secret) });
    }
    const vars = [...envByKey.entries()].map(([key, meta]) => ({ key, value: meta.value, isSecret: meta.isSecret }));
    if (vars.length > 0) await setEnvVars("application", application.id, ownerId, vars);

    // Volumes: each template volume gets a server-local docker volume or a NAS
    // mount, per the operator's storage choice.
    for (const volume of template.volumes ?? []) {
        const choice = input.storage.find((item) => item.volumeName === volume.name);
        const useNas = choice?.backing === "nas" && Boolean(choice.connectionId);
        await createVolume(ownerId, {
            applicationId: application.id,
            name: volume.name,
            mountPath: volume.mountPath,
            kind: useNas ? "nas" : "volume",
            ...(useNas ? { connectionId: choice!.connectionId } : {})
        });
    }

    const installed = await prisma.installedApp.create({
        data: {
            catalogId: app.id,
            ownerId,
            name: input.name,
            targetId: target.id,
            applicationId: application.id,
            status: "installing",
            installedById: actorId
        }
    });

    // Kick off the first deploy; a failure is surfaced on the app's own page and
    // recorded on the install, but installation itself still succeeds.
    try {
        await deployApplication(application.id, ownerId, actorId);
        await prisma.installedApp.update({ where: { id: installed.id }, data: { status: "running" } });
    } catch {
        await prisma.installedApp.update({ where: { id: installed.id }, data: { status: "failed" } });
    }

    return { installedAppId: installed.id, applicationId: application.id };
}

/** The owner's installed apps, newest first, excluding removed ones. */
export async function listInstalledApps(ownerId: string): Promise<InstalledAppView[]> {
    const rows = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        orderBy: { createdAt: "desc" }
    });
    return rows.map((row) => ({
        id: row.id,
        catalogId: row.catalogId,
        name: row.name,
        status: row.status,
        applicationId: row.applicationId,
        targetId: row.targetId,
        createdAt: row.createdAt.toISOString()
    }));
}
