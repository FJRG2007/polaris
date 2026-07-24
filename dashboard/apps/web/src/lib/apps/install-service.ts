/**
 * Installing a marketplace app is a thin orchestration over Deploy: it resolves
 * the chosen server (a DeployTarget), creates a Deploy Application from the
 * manifest's compose template, wires the operator's env and storage choices, and
 * records an InstalledApp row linking the two. No new runtime - the container is
 * built, deployed and managed by the same engine as any deployed app.
 */

import { randomBytes } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { encryptSecret } from "@polaris/storage";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { listHosts } from "@/lib/host-service";
import { createApplication, createProject, deleteApplication, deployApplication } from "@/lib/deploy-service";
import { createVolume } from "@/lib/deploy-volume-service";
import { setEnvVars } from "@/lib/env-var-service";
import { appBaseUrl } from "@/lib/domain-service";
import { invalidateBridgeCache } from "@/lib/messaging/bridge-endpoint";
import { appHasCapability, findApp, isInstallable } from "@/lib/apps/catalog";
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

    // The messaging hub needs the web and the bridge to share two secrets: the API
    // bearer and the inbound ingest key. Minted here, injected as the bridge's env,
    // and stored (encrypted) on the install so the web can resolve them later.
    const isHub = appHasCapability(app, "messaging-hub");
    const bridgeToken = isHub ? randomBytes(32).toString("hex") : null;
    const ingestKey = isHub ? randomBytes(32).toString("hex") : null;

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
        sourceConfig: {
            imageRef: image,
            ...(primaryPort ? { port: primaryPort } : {})
        }
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
    // Hub wiring: the bridge reads these at startup (see services/messaging-bridge).
    // WEB_INGEST_URL defaults to the public app URL; a locally-installed hub has it
    // overridden to the web's internal ingest (service DNS) at deploy time, since the
    // public URL does not resolve from inside a deployed container.
    if (isHub && bridgeToken && ingestKey) {
        const bridgePort = template.ports?.[0]?.container ?? 8787;
        envByKey.set("BRIDGE_TOKEN", { value: bridgeToken, isSecret: true });
        envByKey.set("WEB_INGEST_KEY", { value: ingestKey, isSecret: true });
        envByKey.set("WEB_INGEST_URL", { value: `${await appBaseUrl()}/api/inbox/ingest`, isSecret: false });
        envByKey.set("BRIDGE_PORT", { value: String(bridgePort), isSecret: false });
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

    // Persist the hub's shared secrets (encrypted) on the install, so the web can
    // resolve the bridge's bearer + ingest key when it dials it later.
    const secretBlob =
        isHub && bridgeToken && ingestKey
            ? encryptSecret(JSON.stringify({ token: bridgeToken, ingestKey }), loadEnv().POLARIS_MASTER_KEY)
            : null;

    const installed = await prisma.installedApp.create({
        data: {
            catalogId: app.id,
            ownerId,
            name: input.name,
            targetId: target.id,
            applicationId: application.id,
            status: "installing",
            installedById: actorId,
            ...(secretBlob
                ? {
                      encryptedSecret: secretBlob.ciphertext,
                      secretNonce: secretBlob.nonce,
                      secretKeyId: secretBlob.keyId
                  }
                : {})
        }
    });

    // Kick off the first deploy; a failure is surfaced on the app's own page and
    // recorded on the install, but installation itself still succeeds.
    try {
        await deployApplication(application.id, ownerId, actorId);
        await prisma.installedApp.update({ where: { id: installed.id }, data: { status: "running" } });
        // The inbox resolves the bridge from installs; drop the cache so it appears
        // configured immediately after this hub install rather than after the TTL.
        if (isHub) invalidateBridgeCache();
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

export interface InstalledAppDetail extends InstalledAppView {
    /** Catalog display name and how its dashboard is rendered. */
    catalogName: string;
    dashboardKind: string;
    /** The backing Deploy Application's live state (running | stopped | ...). */
    applicationStatus: string | null;
    /** The server it runs on. */
    serverName: string | null;
}

/** One installed app with its backing application state, or null if not the
 *  owner's. Application/target are looked up by id (no FK, per the model). */
export async function getInstalledApp(ownerId: string, id: string): Promise<InstalledAppDetail | null> {
    const row = await prisma.installedApp.findFirst({ where: { id, ownerId } });
    if (!row) return null;
    const manifest = findApp(row.catalogId);
    const application = row.applicationId
        ? await prisma.application.findFirst({ where: { id: row.applicationId }, select: { desiredState: true } })
        : null;
    const target = row.targetId
        ? await prisma.deployTarget.findFirst({ where: { id: row.targetId }, select: { name: true } })
        : null;
    return {
        id: row.id,
        catalogId: row.catalogId,
        name: row.name,
        status: row.status,
        applicationId: row.applicationId,
        targetId: row.targetId,
        createdAt: row.createdAt.toISOString(),
        catalogName: manifest?.name ?? row.catalogId,
        dashboardKind: manifest?.dashboard ?? "generic",
        applicationStatus: application?.desiredState ?? null,
        serverName: target?.name ?? null
    };
}

/** Remove an installed app: tear down its Deploy application (best effort, it may
 *  already be gone) and mark the install removed so it drops out of the lists. */
export async function uninstallApp(ownerId: string, id: string): Promise<void> {
    const row = await prisma.installedApp.findFirst({ where: { id, ownerId } });
    if (!row) throw new Error("Installed app not found");
    if (row.applicationId) {
        try {
            await deleteApplication(row.applicationId, ownerId);
        } catch {
            // The application may already have been removed in Deploy; proceed.
        }
    }
    await prisma.installedApp.update({ where: { id: row.id }, data: { status: "removed" } });
    // Forget any cached bridge endpoint so the inbox reflects the removal at once.
    if (row.catalogId === "messaging-bridge") invalidateBridgeCache();
}
