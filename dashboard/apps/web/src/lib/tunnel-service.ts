/**
 * Outbound tunnels (Cloudflare Tunnel, ngrok) so a self-hosted box behind NAT can
 * expose its apps publicly with no port-forwarding. The tunnel runs as one
 * container per server: it connects out to the provider and forwards inbound
 * traffic to the local Caddy (the host's published :80), which then routes each
 * hostname to its app. Only the provider and token are stored (token encrypted);
 * the public hostnames themselves are configured with the provider (e.g. the
 * Cloudflare dashboard maps a hostname to http://<box-ip>:80).
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import type { ComposeSpec } from "@polaris/deploy";
import { HostdPorts } from "./deploy/ports-hostd";
import { getPublicIp } from "./domain-service";

const KEYS = { provider: "tunnel.provider", token: "tunnel.token" } as const;
const PROJECT = "polaris-tunnel";
const SERVICE = "polaris-tunnel";
const PROXY_NETWORK = "polaris-proxy";

export type TunnelProvider = "none" | "cloudflare" | "ngrok";

export interface TunnelStatus {
    provider: TunnelProvider;
    hasToken: boolean;
    running: boolean;
}

async function getSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

async function setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({ where: { key }, create: { key, value, scope: "global" }, update: { value } });
}

async function getToken(): Promise<string | null> {
    const raw = await getSetting(KEYS.token);
    if (!raw) return null;
    try {
        const { c, n, k } = JSON.parse(raw) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
    const provider = ((await getSetting(KEYS.provider)) ?? "none") as TunnelProvider;
    const hasToken = Boolean(await getSetting(KEYS.token));
    return { provider, hasToken, running: await tunnelRunning() };
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
function tunnelSpec(provider: TunnelProvider, token: string, boxIp: string | null): ComposeSpec {
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
    const provider = ((await getSetting(KEYS.provider)) ?? "none") as TunnelProvider;
    const token = await getToken();
    const ports = new HostdPorts();
    try {
        if (provider === "none" || !token) {
            await ports.composeDown(PROJECT).catch(() => undefined);
            return;
        }
        await ports.composeUp(tunnelSpec(provider, token, await getPublicIp()));
    } finally {
        await ports.dispose();
    }
}

/** Save the tunnel provider and (optionally) a new token, then reconcile. */
export async function setTunnelConfig(input: { provider: TunnelProvider; token?: string }): Promise<void> {
    await setSetting(KEYS.provider, input.provider === "none" ? null : input.provider);
    if (input.token !== undefined) {
        const trimmed = input.token.trim();
        if (!trimmed) {
            await setSetting(KEYS.token, null);
        } else {
            const blob = encryptSecret(trimmed, loadEnv().POLARIS_MASTER_KEY);
            await setSetting(
                KEYS.token,
                JSON.stringify({
                    c: blob.ciphertext.toString("base64"),
                    n: blob.nonce.toString("base64"),
                    k: blob.keyId
                })
            );
        }
    }
    await applyTunnel();
}
