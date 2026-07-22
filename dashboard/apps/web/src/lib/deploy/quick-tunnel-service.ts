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
import { syncAppRoutes } from "../deploy-service";

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

/** Prefix shared by every quick-tunnel URL setting, so live tunnels are listable. */
const URL_KEY_PREFIX = "deploy.qtunnel.";

/** Setting key caching the current public URL, so the UI shows it across requests. */
function urlKey(appId: string): string {
    return `${URL_KEY_PREFIX}${appId}`;
}

/**
 * Stable internal hostname the edge routes an app's quick tunnel through. cloudflared
 * forwards to Traefik with this as the Host header (rather than dialing the app's port
 * directly), so tunnel traffic is logged at the edge like every other request instead
 * of bypassing it - the reason HTTP Logs stayed empty. Only cloudflared ever sends
 * this header; it is never a public, resolvable name.
 */
export function tunnelHostForApp(appId: string): string {
    return `${shortHash(appId, 8)}.qtunnel.polaris`;
}

/** App ids with a quick tunnel currently up - one URL setting exists per live tunnel. */
export async function quickTunnelAppIds(): Promise<string[]> {
    const rows = await prisma.setting.findMany({
        where: { key: { startsWith: URL_KEY_PREFIX } },
        select: { key: true }
    });
    return rows.map((row) => row.key.slice(URL_KEY_PREFIX.length)).filter(Boolean);
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

/** The cloudflared sidecar spec: forward the edge to Traefik with the app's internal
 *  tunnel host, so every request traverses the edge (and its access log) instead of
 *  hitting the container port directly. */
function tunnelSpec(project: string, service: string, origin: string, hostHeader: string): ComposeSpec {
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
                // trycloudflare.com hostname and forwards it to Traefik, overriding the
                // Host header so the edge routes it to this app (and logs the request).
                command: ["tunnel", "--no-autoupdate", "--url", origin, "--http-host-header", hostHeader],
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
    // Forward to Traefik (the edge), not the app's port, so tunnel requests are logged
    // at the edge like any other. Traefik routes them to this app by the tunnel host.
    const origin = `http://${ip}:80`;

    const ports = new HostdPorts();
    try {
        // Recreate cleanly so a restart always mints a fresh URL rather than reusing
        // a dead container's stale one.
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, origin, tunnelHostForApp(appId)));

        // cloudflared prints the trycloudflare.com URL ~10-15s after it starts, so
        // poll its logs for up to ~30s before giving up (the UI can refresh later).
        let url: string | null = null;
        for (let attempt = 0; attempt < 20 && !url; attempt += 1) {
            await delay(1500);
            url = await readUrlFromLogs(ports, service);
        }
        // Mark the tunnel live even when the URL has not printed yet: the edge route is
        // keyed on this record's existence (via quickTunnelAppIds), not on a known URL,
        // so a slow-starting tunnel still gets routed instead of 404'ing.
        await markTunnelLive(appId, url);
        // Publish the edge route for this tunnel's host so the first request is proxied
        // (and logged) rather than 404'd by the edge for an unknown host.
        await syncAppRoutes().catch(() => undefined);
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
    await forgetTunnel(appId);
    // Drop the tunnel's edge route now that it is gone.
    await syncAppRoutes().catch(() => undefined);
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
            await forgetTunnel(appId);
            return { running: false, url: null };
        }
        const url = (await readUrlFromLogs(ports, service)) ?? (await getStoredUrl(appId));
        await markTunnelLive(appId, url);
        return { running: true, url };
    } catch {
        return { running: false, url: await getStoredUrl(appId) };
    } finally {
        await ports.dispose();
    }
}

/**
 * Migrate/self-heal quick tunnels on boot: an older tunnel forwards straight to the
 * app's port (bypassing the edge, so its traffic never reaches the access log). For
 * each live tunnel whose sidecar does not already target the edge, recreate it through
 * Traefik. A tunnel already on the edge is left untouched, so a routine restart neither
 * churns its URL nor interrupts it. Best-effort and self-guarding.
 */
export async function reconcileQuickTunnels(): Promise<void> {
    const appIds = await quickTunnelAppIds();
    if (appIds.length === 0) return;
    const ip = await getPublicIp();
    if (!ip) return;
    const expectedOrigin = `http://${ip}:80`;
    for (const appId of appIds) {
        const app = await prisma.application.findFirst({
            where: { id: appId, target: { kind: "local" } },
            select: { environment: { select: { project: { select: { ownerId: true } } } } }
        });
        const ownerId = app?.environment.project.ownerId;
        if (!ownerId) continue;

        const { service } = names(appId);
        const ports = new HostdPorts();
        let onEdge = false;
        try {
            const info = (await ports.inspect(service)) as {
                State?: { Running?: boolean };
                Config?: { Cmd?: string[] };
            };
            onEdge = Boolean(info?.State?.Running) && (info?.Config?.Cmd ?? []).includes(expectedOrigin);
        } catch {
            // Not running - startQuickTunnel below recreates it.
        } finally {
            await ports.dispose();
        }
        if (onEdge) continue;
        await startQuickTunnel(appId, ownerId).catch((error) =>
            console.error(`polaris: quick-tunnel reconcile failed for ${appId}:`, error)
        );
    }
}

async function getStoredUrl(appId: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key: urlKey(appId) }, select: { value: true } });
    // A live-but-URL-unknown tunnel stores an empty marker; report that as no URL yet.
    return row?.value || null;
}

/** Record the tunnel as live and cache its URL if known. The record's existence (not its
 *  value) is what quickTunnelAppIds reports and what syncAppRoutes keys the edge route on,
 *  so it must be written the moment the sidecar is up - an empty value marks a live tunnel
 *  whose URL cloudflared has not printed yet. */
async function markTunnelLive(appId: string, url: string | null): Promise<void> {
    const key = urlKey(appId);
    const value = url ?? "";
    await prisma.setting.upsert({
        where: { key },
        create: { key, value, scope: "global" },
        update: { value }
    });
}

/** Forget the tunnel: drop its liveness record and cached URL. Called only when the tunnel
 *  is actually gone (stopped or not running), so the edge route is withdrawn with it. */
async function forgetTunnel(appId: string): Promise<void> {
    await prisma.setting.deleteMany({ where: { key: urlKey(appId) } });
}
