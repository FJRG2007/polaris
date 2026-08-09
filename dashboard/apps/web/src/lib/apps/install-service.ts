/**
 * Installing a marketplace app is a thin orchestration over Deploy: it resolves
 * the chosen server (a DeployTarget), creates a Deploy Application from the
 * manifest's compose template, wires the operator's env and storage choices, and
 * records an InstalledApp row linking the two. No new runtime - the container is
 * built, deployed and managed by the same engine as any deployed app.
 */

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { slugify } from "@polaris/deploy";
import { listHosts } from "@/lib/host-service";
import { encryptSecret } from "@polaris/storage";
import { appBaseUrl } from "@/lib/domain-service";
import { createVolume } from "@/lib/deploy-volume-service";
import { availableHostPort } from "@/lib/apps/port-registry";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import type { AppInstallInput } from "@/lib/apps/install-schema";
import { invalidateBridgeCache } from "@/lib/messaging/bridge-endpoint";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { createApplication, createProject, deleteApplication, deployApplication } from "@/lib/deploy-service";
import { appHasCapability, findApp, isAllowedEnvValue, isInstallable, tunableEnvVars } from "@/lib/apps/catalog";

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
    /** Who installed it. A list can now hold apps somebody was given access to as
     *  well as their own, and the two do not offer the same things. */
    ownerId: string;
}

/** A name no service in this environment is using yet, numbering repeats the way
 *  a file manager does ("Minecraft server 2"). */
async function availableInstanceName(environmentId: string, wanted: string): Promise<string> {
    // Compared as slugs, because that is what the database holds unique - two
    // names that read differently can still be the same service.
    const taken = new Set(
        (await prisma.application.findMany({ where: { environmentId }, select: { slug: true } })).map((row) => row.slug)
    );
    if (!taken.has(slugify(wanted))) return wanted;
    for (let suffix = 2; suffix < 100; suffix += 1) {
        const candidate = `${wanted} ${suffix}`;
        if (!taken.has(slugify(candidate))) return candidate;
    }
    throw new Error("Too many installs of this app - rename one first");
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
    input: AppInstallInput,
    /** Further ports the caller needs published beside the manifest's own. A Java
     *  Minecraft server that Bedrock clients join answers on a UDP port too. */
    extraPorts?: readonly { host: number; container: number; protocol?: "tcp" | "udp" }[]
): Promise<{ installedAppId: string; applicationId: string | null }> {
    const app = findApp(input.catalogId);
    if (!app) throw new Error("Unknown app");
    if (!isInstallable(app)) throw new Error("This app cannot be installed yet");

    if (app.singleton) {
        const existing = await prisma.installedApp.findFirst({
            where: { ownerId, catalogId: app.id, status: { not: "removed" } }
        });
        if (existing) throw new Error("This app is already installed");
    }

    // A builtin app runs nothing: installing it records that this Polaris has the
    // feature, and the dashboard is the app. The Minecraft manager is one - what it
    // creates are the servers, and those are ordinary deployed apps.
    if (app.installMethod === "builtin") {
        const record = await prisma.installedApp.create({
            data: {
                catalogId: app.id,
                ownerId,
                name: input.name,
                status: "running",
                installedById: actorId
            }
        });
        return { installedAppId: record.id, applicationId: null };
    }

    // isInstallable guarantees a compose template with an image.
    const template = app.template!;
    const image = template.image!;

    // The messaging hub needs the web and the bridge to share two secrets: the API
    // bearer and the inbound ingest key. Minted here, injected as the bridge's env,
    // and stored (encrypted) on the install so the web can resolve them later.
    const isHub = appHasCapability(app, "messaging-hub");
    const bridgeToken = isHub ? randomBytes(32).toString("hex") : null;
    const ingestKey = isHub ? randomBytes(32).toString("hex") : null;

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
    const primary = template.ports?.[0];
    // One-click installs all arrive under the app's own name, and a service's slug
    // is unique within its environment - so the second one is numbered rather than
    // rejected with a database error nobody outside Polaris can read.
    const name = await availableInstanceName(environmentId, input.name);
    // An app that declares the host port it wants is one people reach by typing an
    // address (a game server): publish it there, on the transport its clients speak.
    const hostPort = primary?.host
        ? await availableHostPort(primary.host, primary.protocol === "udp" ? "udp" : "tcp")
        : undefined;
    const application = await createApplication(ownerId, {
        environmentId,
        targetId: target.id,
        name,
        sourceType: "image",
        sourceConfig: {
            imageRef: image,
            ...(primary?.container ? { port: primary.container } : {}),
            ...(hostPort ? { hostPort, hostProtocol: primary?.protocol === "udp" ? "udp" : "tcp" } : {}),
            ...(extraPorts && extraPorts.length > 0 ? { extraPorts } : {})
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
        // A value the form should never have sent (an unknown key, or one outside a
        // field's declared options) is dropped rather than trusted: the manifest is
        // the contract, and the client is not the one that enforces it.
        if (!declared || declared.generated || !isAllowedEnvValue(declared, entry.value)) continue;
        envByKey.set(entry.key, { value: entry.value, isSecret: Boolean(declared.secret) });
    }
    // Generated vars are the app's own credentials (Minecraft's RCON password): minted
    // here so nobody is asked for them and no app ships a default one.
    for (const declared of template.env ?? []) {
        if (declared.generated) envByKey.set(declared.key, { value: randomBytes(24).toString("hex"), isSecret: true });
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
            name,
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

/**
 * The owner's installed apps, newest first, excluding removed ones.
 *
 * `alsoIds` widens the answer to apps somebody was granted access to but does not
 * own. One query rather than one per owner, and it stays a list: opening any of
 * them still resolves the grant properly, so a row here can never be more than a
 * row.
 */
export async function listInstalledApps(
    ownerId: string,
    alsoIds: readonly string[] = []
): Promise<InstalledAppView[]> {
    const mine = { ownerId, status: { not: "removed" } };
    const rows = await prisma.installedApp.findMany({
        where: alsoIds.length > 0 ? { OR: [mine, { id: { in: [...alsoIds] }, status: { not: "removed" } }] } : mine,
        orderBy: { createdAt: "desc" }
    });
    return rows.map((row) => ({
        id: row.id,
        catalogId: row.catalogId,
        name: row.name,
        status: row.status,
        applicationId: row.applicationId,
        targetId: row.targetId,
        createdAt: row.createdAt.toISOString(),
        ownerId: row.ownerId
    }));
}

/** An installed app that is backed by a deployed service, named as the app. */
export interface InstalledAppScope {
    /** The service the rules actually attach to. */
    readonly applicationId: string;
    readonly label: string;
}

/**
 * The owner's marketplace installs, as somewhere a rule can be pointed.
 *
 * Somebody who installed Minecraft knows it as Minecraft, not as the service slug
 * it happens to run under three levels down a project tree, so any screen that asks
 * "which of your things is this about" should be able to offer the app by name.
 * Only installs with a service: a builtin app runs no container to guard.
 */
export async function listInstalledAppScopes(ownerId: string): Promise<InstalledAppScope[]> {
    const rows = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        orderBy: { name: "asc" },
        select: { name: true, catalogId: true, applicationId: true }
    });
    return rows.map((row) => {
        const manifest = findApp(row.catalogId);
        // The catalog name disambiguates two installs of the same app, which is the
        // case the bare instance name reads worst in.
        const kind = manifest?.name ?? row.catalogId;
        return {
            applicationId: row.applicationId as string,
            label: kind === row.name ? row.name : `${row.name} (${kind})`
        };
    });
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
        ownerId: row.ownerId,
        catalogName: manifest?.name ?? row.catalogId,
        dashboardKind: manifest?.dashboard ?? "generic",
        applicationStatus: application?.desiredState ?? null,
        serverName: target?.name ?? null
    };
}

/** One settings field of an installed app: what the manifest declares, filled in
 *  with what this install is actually running on. */
export interface InstalledAppSetting {
    key: string;
    label: string;
    help?: string;
    group?: string;
    value: string;
    options?: Array<{ value: string; label: string }>;
}

/**
 * The settings an installed app exposes, in manifest order. The value is the one
 * the container was deployed with, falling back to the manifest default for a
 * variable that was never set - which is what the app is running on either way,
 * since the image applies the same default.
 */
export async function getInstalledAppSettings(ownerId: string, id: string): Promise<InstalledAppSetting[]> {
    const row = await prisma.installedApp.findFirst({ where: { id, ownerId } });
    if (!row) return [];
    const manifest = findApp(row.catalogId);
    if (!manifest) return [];
    const fields = tunableEnvVars(manifest);
    if (fields.length === 0 || !row.applicationId) return [];
    // An install whose service is gone has no settings to show, and that is all it
    // means here. It must never be an exception: this is one panel on the page an
    // operator opens to get rid of exactly such an install, and a throw takes the
    // page - Uninstall included - down with it.
    const stored = new Map(
        (await listEnvVars("application", row.applicationId, ownerId).catch(() => [])).map((item) => [
            item.key,
            item.value
        ])
    );
    return fields.map((field) => ({
        key: field.key,
        label: field.label,
        ...(field.help ? { help: field.help } : {}),
        ...(field.group ? { group: field.group } : {}),
        value: stored.get(field.key) ?? field.default ?? "",
        ...(field.options ? { options: [...field.options] } : {})
    }));
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
