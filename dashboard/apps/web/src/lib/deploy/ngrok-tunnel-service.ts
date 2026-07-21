/**
 * Per-app ngrok tunnels: expose one deployed app on a public ngrok URL with no
 * port-forwarding, using the authtoken from the ngrok integration. An `ngrok`
 * sidecar connects out to ngrok's edge and forwards inbound traffic to the app's
 * already-published host port (see hostPortForApp), mirroring quick-tunnel-service
 * for the sidecar lifecycle. The URL is read back from the agent's logs (ngrok
 * prints `url=https://...` on startup) and cached in a Setting for the UI.
 *
 * ngrok's free plan allows a single simultaneous agent per account, so only one
 * ngrok tunnel (per-app or the server-wide one) runs at a time; a second start
 * surfaces ngrok's own error from the logs.
 */

import { prisma } from "@polaris/db";
import type { ComposeSpec } from "@polaris/deploy";
import { shortHash } from "@polaris/deploy";
import { HostdPorts } from "./ports-hostd";
import { getPublicIp } from "../domain-service";
import { hostPortForApp } from "../deploy-service";
import { getIntegrationSecret, getIntegrationState } from "../integration-service";

const PROXY_NETWORK = "polaris-proxy";
const IMAGE = "ngrok/ngrok:latest";
/** ngrok public hostnames (free `.ngrok-free.app`, paid `.ngrok.app`, legacy `.ngrok.io`). */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/i;

export interface NgrokTunnelStatus {
    running: boolean;
    /** The public URL while the tunnel is up, or null. */
    url: string | null;
    /** Whether the ngrok integration has an authtoken (so the UI can offer start). */
    configured: boolean;
}

function names(appId: string): { project: string; service: string } {
    const hash = shortHash(appId, 8);
    return { project: `polaris-ngrok-${hash}`, service: `ngrok-${hash}` };
}

function urlKey(appId: string): string {
    return `deploy.ngrok.${appId}`;
}

/** Load an app the caller owns, or throw. ngrok tunnels run on the local host. */
async function requireLocalApp(appId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        include: { target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("ngrok tunnels are available for apps deployed on this server");
    }
}

/** The ngrok sidecar spec forwarding the edge to the app's published host port. */
function tunnelSpec(project: string, service: string, origin: string, token: string): ComposeSpec {
    return {
        project,
        services: [
            {
                name: service,
                image: IMAGE,
                env: { NGROK_AUTHTOKEN: token },
                ports: [],
                volumes: [],
                labels: {},
                command: ["http", origin, "--log", "stdout"],
                networks: [PROXY_NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [PROXY_NETWORK]
    };
}

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

/** The stored ngrok authtoken when the integration is enabled with a secret. */
async function ngrokToken(): Promise<string | null> {
    const state = await getIntegrationState("ngrok");
    if (!state?.hasSecret) return null;
    return getIntegrationSecret("ngrok");
}

/**
 * Start (or restart) the app's ngrok tunnel and return its public URL. Brings up a
 * fresh ngrok sidecar pointed at the app's host IP:port, then polls its logs until
 * the ngrok URL appears.
 */
export async function startNgrokTunnel(appId: string, ownerId: string): Promise<NgrokTunnelStatus> {
    await requireLocalApp(appId, ownerId);
    const token = await ngrokToken();
    if (!token) throw new Error("Add your ngrok authtoken under Integrations first");
    const ip = await getPublicIp();
    if (!ip) throw new Error("Set this server's IP under Deploy settings first");

    const { project, service } = names(appId);
    const origin = `${ip}:${hostPortForApp(appId)}`;
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, origin, token));

        let url: string | null = null;
        for (let attempt = 0; attempt < 20 && !url; attempt += 1) {
            await delay(1500);
            url = await readUrlFromLogs(ports, service);
        }
        await setStoredUrl(appId, url);
        return { running: true, url, configured: true };
    } finally {
        await ports.dispose();
    }
}

/** Tear down the app's ngrok tunnel and forget its URL. Idempotent. */
export async function stopNgrokTunnel(appId: string, ownerId: string): Promise<void> {
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

/** Whether the tunnel is up and its current public URL. Best-effort. */
export async function getNgrokTunnelStatus(appId: string, ownerId: string): Promise<NgrokTunnelStatus> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
    const configured = Boolean(await ngrokToken());
    const { service } = names(appId);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean } };
        if (!info?.State?.Running) {
            await setStoredUrl(appId, null);
            return { running: false, url: null, configured };
        }
        const url = (await readUrlFromLogs(ports, service)) ?? (await getStoredUrl(appId));
        await setStoredUrl(appId, url);
        return { running: true, url, configured };
    } catch {
        return { running: false, url: await getStoredUrl(appId), configured };
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
    await prisma.setting.upsert({ where: { key }, create: { key, value: url, scope: "global" }, update: { value: url } });
}
