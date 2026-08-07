/**
 * Outbound tunnels (Cloudflare Tunnel, ngrok) so a self-hosted box behind NAT can
 * expose its apps publicly with no port-forwarding. The tunnel runs as one
 * container per server: it connects out to the provider and forwards inbound
 * traffic to the local edge, which then routes each hostname to its app - by the
 * edge's name on the shared network, since the connector is on it and the box's own
 * address is not a fixed thing. Credentials live in Integrations (the `cloudflare`/`ngrok`
 * integration secrets); the public hostnames themselves are configured with the
 * provider (e.g. the Cloudflare dashboard maps a hostname to http://<box-ip>:80).
 */

import { edgeAddress } from "./deploy/dial";
import { HostdPorts } from "./deploy/ports-hostd";
import type { ComposeSpec } from "@polaris/deploy";
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

/**
 * What the connector is run with. Its own function because the reconcile below reads
 * the same command back off the running container: an origin that has since changed
 * is invisible in "is it running", and that is exactly the state to repair.
 */
function tunnelCommand(provider: (typeof PROVIDERS)[number]): string[] {
    // Cloudflare's token carries its ingress (configured in the CF dashboard to
    // point at http://<box-ip>:80). ngrok forwards to the edge by its name on this
    // network - the container is on it, and the box's LAN address is a value that
    // moves, which would leave the tunnel forwarding into nothing.
    return provider === "cloudflare" ? ["tunnel", "--no-autoupdate", "run"] : ["http", edgeAddress()];
}

/** The compose spec for the tunnel container of the chosen provider. */
function tunnelSpec(provider: (typeof PROVIDERS)[number], token: string): ComposeSpec {
    const isCloudflare = provider === "cloudflare";
    const env: Record<string, string> = isCloudflare ? { TUNNEL_TOKEN: token } : { NGROK_AUTHTOKEN: token };
    const service = {
        name: SERVICE,
        image: isCloudflare ? "cloudflare/cloudflared:latest" : "ngrok/ngrok:latest",
        // Both are floating tags from a registry, so compose has to re-resolve
        // them rather than reuse the copy the host happens to hold.
        pullPolicy: "always" as const,
        env,
        ports: [],
        volumes: [],
        labels: {},
        command: tunnelCommand(provider),
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
        await ports.composeUp(tunnelSpec(active.provider, active.token));
    } finally {
        await ports.dispose();
    }
}

/**
 * Bring a connector that is already up back in line with the origin it should be
 * forwarding to, on boot.
 *
 * A connector is raised once and then simply keeps running, so an origin corrected
 * afterwards never reaches it: the container stays up, the tunnel stays registered,
 * and every request through it reaches an address that no longer answers. Recreated
 * only when the command it is running differs - a connector already on the right
 * origin is left alone, since restarting one costs its public URL.
 *
 * Best-effort: a tunnel is a convenience, and failing to reconcile it must not take
 * the boot with it.
 */
export async function reconcileTunnel(): Promise<void> {
    const active = await activeTunnel();
    if (!active) return;
    const expected = tunnelCommand(active.provider);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(SERVICE).catch(() => null)) as {
            State?: { Running?: boolean };
            Config?: { Cmd?: string[] };
        } | null;
        const serving = Boolean(info?.State?.Running) && (info?.Config?.Cmd ?? []).join(" ") === expected.join(" ");
        if (serving) return;
        await ports.composeUp(tunnelSpec(active.provider, active.token));
    } catch (error) {
        console.error("polaris: tunnel reconcile failed:", error instanceof Error ? error.message : error);
    } finally {
        await ports.dispose();
    }
}
