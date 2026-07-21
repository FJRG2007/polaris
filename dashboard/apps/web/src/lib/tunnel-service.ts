/**
 * Outbound tunnels (Cloudflare Tunnel, ngrok) so a self-hosted box behind NAT can
 * expose its apps publicly with no port-forwarding. The tunnel runs as one
 * container per server: it connects out to the provider and forwards inbound
 * traffic to the local Caddy (the host's published :80), which then routes each
 * hostname to its app. Credentials live in Integrations (the `cloudflare`/`ngrok`
 * integration secrets); the public hostnames themselves are configured with the
 * provider (e.g. the Cloudflare dashboard maps a hostname to http://<box-ip>:80).
 */

import type { ComposeSpec } from "@polaris/deploy";
import { HostdPorts } from "./deploy/ports-hostd";
import { getPublicIp } from "./domain-service";
import { getIntegrationSecret, getIntegrationState } from "./integration-service";

const PROJECT = "polaris-tunnel";
const SERVICE = "polaris-tunnel";
const PROXY_NETWORK = "polaris-proxy";

export type TunnelProvider = "none" | "cloudflare" | "ngrok";
const PROVIDERS = ["cloudflare", "ngrok"] as const;

export interface TunnelStatus {
    provider: TunnelProvider;
    running: boolean;
}

/** The enabled tunnel provider and its token, or null when none is configured. A
 *  single tunnel runs per server, so the first enabled provider with a token wins. */
async function activeTunnel(): Promise<{ provider: (typeof PROVIDERS)[number]; token: string } | null> {
    for (const provider of PROVIDERS) {
        const state = await getIntegrationState(provider);
        if (!state?.enabled) continue;
        const token = await getIntegrationSecret(provider);
        if (token) return { provider, token };
    }
    return null;
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
    const active = await activeTunnel();
    return { provider: active?.provider ?? "none", running: await tunnelRunning() };
}

/** Whether the tunnel container is up (best-effort). The tunnel always runs on the
 *  local Polaris host, so it talks to the host daemon directly. */
async function tunnelRunning(): Promise<boolean> {
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(SERVICE)) as { State?: { Running?: boolean } };
        return Boolean(info?.State?.Running);
    } catch {
        return false;
    } finally {
        await ports.dispose();
    }
}

/** The compose spec for the tunnel container of the chosen provider. */
function tunnelSpec(provider: (typeof PROVIDERS)[number], token: string, boxIp: string | null): ComposeSpec {
    const isCloudflare = provider === "cloudflare";
    const env: Record<string, string> = isCloudflare ? { TUNNEL_TOKEN: token } : { NGROK_AUTHTOKEN: token };
    const service = {
        name: SERVICE,
        image: isCloudflare ? "cloudflare/cloudflared:latest" : "ngrok/ngrok:latest",
        env,
        ports: [],
        volumes: [],
        labels: {},
        // Cloudflare's token carries its ingress (configured in the CF dashboard to
        // point at http://<box-ip>:80). ngrok forwards to the box's Caddy directly.
        command: isCloudflare ? ["tunnel", "--no-autoupdate", "run"] : ["http", `${boxIp ?? "host.docker.internal"}:80`],
        networks: [PROXY_NETWORK],
        restart: "unless-stopped"
    };
    return { project: PROJECT, services: [service], volumes: [], networks: [PROXY_NETWORK] };
}

/**
 * Reconcile the running tunnel with the stored config: bring up the provider's
 * container (or tear it down when set to none / no token). Idempotent.
 */
export async function applyTunnel(): Promise<void> {
    const active = await activeTunnel();
    const ports = new HostdPorts();
    try {
        if (!active) {
            await ports.composeDown(PROJECT).catch(() => undefined);
            return;
        }
        await ports.composeUp(tunnelSpec(active.provider, active.token, await getPublicIp()));
    } finally {
        await ports.dispose();
    }
}
