/**
 * A Cloudflare Quick Tunnel for Polaris itself, so share links and drop points work
 * from the internet even when the box is behind NAT with no port-forwarding and no
 * public domain. A `cloudflared` sidecar joins the dashboard's own network and
 * forwards a public `*.trycloudflare.com` URL to the web container; that URL then
 * fronts the public `/s` and `/r` pages (and the auth-gated dashboard). The URL is
 * ephemeral - read from the agent's logs and cached in a Setting - so it is a
 * zero-config fallback, not a stable domain (configure a domain/tunnel for that).
 *
 * Mirrors deploy/quick-tunnel-service.ts, but the origin is Polaris's web container
 * on its own compose network rather than a deployed app's published host port.
 */

import { prisma } from "@polaris/db";
import { newestUrl } from "./deploy/tunnel-url";
import { dashboardOrigin } from "./domain-edge";
import { HostdPorts } from "./deploy/ports-hostd";
import type { ComposeSpec } from "@polaris/deploy";
import { PUBLIC_TUNNEL_PROJECT } from "./polaris-parts";

const PROJECT = PUBLIC_TUNNEL_PROJECT;
const SERVICE = "ptunnel";
const IMAGE = "cloudflare/cloudflared:latest";
const URL_KEY = "polaris.ptunnel.url";
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Origin the tunnel forwards to: the dashboard web container on its compose network,
 *  by the same service name the edge dials it on. It used to name the container itself
 *  (`polaris-web-1`), which every self-update replaces with a differently numbered one -
 *  so the connector stayed up, kept its public URL, and forwarded every request into a
 *  name that no longer resolved. Overridable for a non-default compose project name. */
const ORIGIN = process.env.POLARIS_TUNNEL_ORIGIN ?? dashboardOrigin();
const NETWORK = process.env.POLARIS_TUNNEL_NETWORK ?? "polaris_default";

export interface PolarisTunnelStatus {
    running: boolean;
    url: string | null;
}

function tunnelSpec(): ComposeSpec {
    return {
        project: PROJECT,
        services: [
            {
                name: SERVICE,
                image: IMAGE,
                // Same reason as every other sidecar on a floating tag: compose
                // would otherwise keep the copy the host first fetched.
                pullPolicy: "always",
                env: {},
                ports: [],
                volumes: [],
                labels: {},
                command: ["tunnel", "--no-autoupdate", "--url", ORIGIN],
                networks: [NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [NETWORK]
    };
}

async function readUrlFromLogs(ports: HostdPorts): Promise<string | null> {
    let buffer = "";
    try {
        await ports.logs(
            SERVICE,
            (chunk) => {
                buffer += chunk.toString("utf8");
            },
            { tail: 200, follow: false }
        );
    } catch {
        return null;
    }
    return newestUrl(buffer, URL_PATTERN);
}

async function getStoredUrl(): Promise<string | null> {
    const row = await prisma.setting.findUnique({
        where: { key: URL_KEY },
        select: { value: true }
    });
    return row?.value ?? null;
}

async function setStoredUrl(url: string | null): Promise<void> {
    if (!url) {
        await prisma.setting.deleteMany({ where: { key: URL_KEY } });
        return;
    }
    await prisma.setting.upsert({
        where: { key: URL_KEY },
        create: { key: URL_KEY, value: url, scope: "global" },
        update: { value: url }
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the connector is up AND forwarding where it should.
 *
 * The origin matters as much as the process: a connector raised against an older
 * origin keeps running, keeps its public URL, and answers every request with a
 * gateway error - and because it is "running", nothing ever replaces it. Reading it
 * back off the container is what lets an origin that has since been corrected reach
 * a tunnel that was raised before it, the way the deploy quick tunnels self-heal.
 */
async function isServing(ports: HostdPorts): Promise<boolean> {
    try {
        const info = (await ports.inspect(SERVICE)) as {
            State?: { Running?: boolean };
            Config?: { Cmd?: string[] };
        };
        return Boolean(info?.State?.Running) && (info?.Config?.Cmd ?? []).includes(ORIGIN);
    } catch {
        return false;
    }
}

/**
 * Ensure the Polaris tunnel is up and return its public URL. Idempotent: if the
 * sidecar is already serving the current origin with a known URL, returns it without
 * restarting; otherwise brings it up and polls the logs until the trycloudflare URL
 * appears. Returns null only if cloudflared never produced a URL.
 */
export async function ensurePolarisTunnel(): Promise<string | null> {
    const ports = new HostdPorts();
    try {
        if (await isServing(ports)) {
            const url = (await readUrlFromLogs(ports)) ?? (await getStoredUrl());
            if (url) {
                await setStoredUrl(url);
                return url;
            }
        }
        await ports.composeUp(tunnelSpec());
        let url: string | null = null;
        for (let attempt = 0; attempt < 20 && !url; attempt += 1) {
            await delay(1500);
            url = await readUrlFromLogs(ports);
        }
        await setStoredUrl(url);
        return url;
    } finally {
        await ports.dispose();
    }
}

/** The current public URL if a tunnel has been raised, else null. Cheap: reads the
 *  cached value (set when the tunnel starts, cleared when it stops) rather than
 *  probing the daemon, since this is on the hot sharing-URL path. */
export async function getPolarisPublicUrl(): Promise<string | null> {
    return getStoredUrl();
}

/** State of the Polaris tunnel for a status/control UI. */
export async function getPolarisTunnelStatus(): Promise<PolarisTunnelStatus> {
    const ports = new HostdPorts();
    try {
        const running = await isServing(ports);
        if (!running) return { running: false, url: null };
        const url = (await readUrlFromLogs(ports)) ?? (await getStoredUrl());
        return { running: true, url };
    } catch {
        return { running: false, url: null };
    } finally {
        await ports.dispose();
    }
}

/** Tear the tunnel down and forget its URL. */
export async function stopPolarisTunnel(): Promise<void> {
    const ports = new HostdPorts();
    try {
        await ports.composeDown(PROJECT).catch(() => undefined);
    } finally {
        await ports.dispose();
    }
    await setStoredUrl(null);
}
