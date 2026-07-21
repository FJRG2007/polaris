/**
 * Per-app Cloudflare Quick Tunnels: expose one deployed app on a public
 * `*.trycloudflare.com` URL with no Cloudflare account, no DNS, and no
 * port-forwarding - the zero-login mode of the OpenTunnel approach. A `cloudflared`
 * sidecar container connects out to Cloudflare's edge and forwards inbound traffic
 * to the app's already-published host port (see hostPortForApp), so it reuses the
 * exact IP:port the app is reachable on locally. The public URL is ephemeral (a new
 * one each time the tunnel starts), so it is read back from the sidecar's logs and
 * cached in a Setting for the UI; a stable custom hostname needs the account-based
 * tunnel configured under Integrations instead.
 */

import { prisma } from "@polaris/db";
import type { ComposeSpec } from "@polaris/deploy";
import { shortHash } from "@polaris/deploy";
import { HostdPorts } from "./ports-hostd";
import { getPublicIp } from "../domain-service";
import { hostPortForApp } from "../deploy-service";

const PROXY_NETWORK = "polaris-proxy";
const IMAGE = "cloudflare/cloudflared:latest";
/** trycloudflare.com quick-tunnel hostname, printed by cloudflared on startup. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface QuickTunnelStatus {
    running: boolean;
    /** The public URL while the tunnel is up, or null. */
    url: string | null;
}

/** Compose project/service names for an app's quick tunnel (charset-safe for hostd). */
function names(appId: string): { project: string; service: string } {
    const hash = shortHash(appId, 8);
    return { project: `polaris-qtunnel-${hash}`, service: `qtunnel-${hash}` };
}

/** Setting key caching the current public URL, so the UI shows it across requests. */
function urlKey(appId: string): string {
    return `deploy.qtunnel.${appId}`;
}

/** Load an app the caller owns, or throw. Quick tunnels run on the local host, so
 *  the app must target it (a remote-host app would need its own local sidecar). */
async function requireLocalApp(appId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        include: { target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("Quick tunnels are available for apps deployed on this server");
    }
}

/** The cloudflared sidecar spec forwarding the edge to the app's published host port. */
function tunnelSpec(project: string, service: string, origin: string): ComposeSpec {
    return {
        project,
        services: [
            {
                name: service,
                image: IMAGE,
                env: {},
                ports: [],
                volumes: [],
                labels: {},
                // Quick tunnel: no token, no account - cloudflared mints a random
                // trycloudflare.com hostname and forwards it to the local origin.
                command: ["tunnel", "--no-autoupdate", "--url", origin],
                networks: [PROXY_NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [PROXY_NETWORK]
    };
}

/** Read the sidecar's current logs and extract the trycloudflare.com URL, or null. */
async function readUrlFromLogs(ports: HostdPorts, service: string): Promise<string | null> {
    let buffer = "";
    try {
        await ports.logs(service, (chunk) => {
            buffer += chunk.toString("utf8");
        }, { tail: 200, follow: false });
    } catch {
        return null;
    }
    return buffer.match(URL_PATTERN)?.[0] ?? null;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start (or restart) the app's quick tunnel and return its public URL. Brings up a
 * fresh cloudflared sidecar pointed at the app's host IP:port, then polls its logs
 * until the trycloudflare.com URL appears (cloudflared prints it within seconds).
 */
export async function startQuickTunnel(appId: string, ownerId: string): Promise<QuickTunnelStatus> {
    await requireLocalApp(appId, ownerId);
    const ip = await getPublicIp();
    if (!ip) throw new Error("Set this server's IP under Deploy settings first");
    const { project, service } = names(appId);
    const origin = `http://${ip}:${hostPortForApp(appId)}`;

    const ports = new HostdPorts();
    try {
        // Recreate cleanly so a restart always mints a fresh URL rather than reusing
        // a dead container's stale one.
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, origin));

        // cloudflared prints the trycloudflare.com URL ~10-15s after it starts, so
        // poll its logs for up to ~30s before giving up (the UI can refresh later).
        let url: string | null = null;
        for (let attempt = 0; attempt < 20 && !url; attempt += 1) {
            await delay(1500);
            url = await readUrlFromLogs(ports, service);
        }
        await setStoredUrl(appId, url);
        return { running: true, url };
    } finally {
        await ports.dispose();
    }
}

/** Tear down the app's quick tunnel and forget its URL. Idempotent. */
export async function stopQuickTunnel(appId: string, ownerId: string): Promise<void> {
    await requireLocalApp(appId, ownerId);
    const { project } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
    } finally {
        await ports.dispose();
    }
    await setStoredUrl(appId, null);
}

/** Whether the tunnel is up and its current public URL (refreshed from the live
 *  container's logs, since the URL changes on every (re)start). Best-effort. */
export async function getQuickTunnelStatus(appId: string, ownerId: string): Promise<QuickTunnelStatus> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
    const { service } = names(appId);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean } };
        if (!info?.State?.Running) {
            await setStoredUrl(appId, null);
            return { running: false, url: null };
        }
        const url = (await readUrlFromLogs(ports, service)) ?? (await getStoredUrl(appId));
        await setStoredUrl(appId, url);
        return { running: true, url };
    } catch {
        return { running: false, url: await getStoredUrl(appId) };
    } finally {
        await ports.dispose();
    }
}

async function getStoredUrl(appId: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key: urlKey(appId) }, select: { value: true } });
    return row?.value ?? null;
}

async function setStoredUrl(appId: string, url: string | null): Promise<void> {
    const key = urlKey(appId);
    if (!url) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({
        where: { key },
        create: { key, value: url, scope: "global" },
        update: { value: url }
    });
}
