/**
 * Per-app Cloudflare named tunnels: expose one deployed app on a STABLE custom
 * hostname (your own domain) instead of the ephemeral trycloudflare.com URL a
 * quick tunnel gives. The operator creates a tunnel in the Cloudflare Zero Trust
 * dashboard, maps their hostname to this service there, and pastes the connector
 * token here; Polaris runs a `cloudflared` sidecar with that token (via the
 * TUNNEL_TOKEN env var), and the connector pulls its ingress config from
 * Cloudflare's edge - so the hostname and its DNS live in the operator's account,
 * survive restarts, and need no port-forwarding.
 *
 * The token is a credential and is stored envelope-encrypted at rest with the
 * master key (never in plaintext); the hostname is stored alongside for display.
 * Mirrors quick-tunnel-service.ts for the sidecar lifecycle.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import type { ComposeSpec } from "@polaris/deploy";
import { shortHash } from "@polaris/deploy";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { HostdPorts } from "./ports-hostd";

const PROXY_NETWORK = "polaris-proxy";
const IMAGE = "cloudflare/cloudflared:latest";

export interface NamedTunnelStatus {
    running: boolean;
    /** The configured stable hostname, when set. */
    hostname: string | null;
    /** Whether a connector token is stored (so the UI can offer start/stop). */
    configured: boolean;
}

/** Compose project/service names for an app's named tunnel (charset-safe for hostd). */
function names(appId: string): { project: string; service: string } {
    const hash = shortHash(appId, 8);
    return { project: `polaris-ntunnel-${hash}`, service: `ntunnel-${hash}` };
}

const tokenKey = (appId: string): string => `deploy.ntunnel.${appId}.token`;
const hostKey = (appId: string): string => `deploy.ntunnel.${appId}.hostname`;

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

/** Load an app the caller owns, or throw. Named tunnels run a local sidecar, so
 *  the app must target this host (a remote-host app would need its own sidecar). */
async function requireLocalApp(appId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        include: { target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("Named tunnels are available for apps deployed on this server");
    }
}

/** Store the connector token encrypted at rest. */
async function storeToken(appId: string, token: string): Promise<void> {
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    await setSetting(
        tokenKey(appId),
        JSON.stringify({ c: blob.ciphertext.toString("base64"), n: blob.nonce.toString("base64"), k: blob.keyId })
    );
}

/** Decrypt the stored connector token, or null when none/undecryptable. */
async function loadToken(appId: string): Promise<string | null> {
    const raw = await getSetting(tokenKey(appId));
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

/** The cloudflared sidecar spec running the named connector from its token. The
 *  token is passed via TUNNEL_TOKEN (env), and the ingress config is pulled from
 *  Cloudflare's edge, so no --url/origin is needed here. */
function tunnelSpec(project: string, service: string, token: string): ComposeSpec {
    return {
        project,
        services: [
            {
                name: service,
                image: IMAGE,
                env: { TUNNEL_TOKEN: token },
                ports: [],
                volumes: [],
                labels: {},
                command: ["tunnel", "--no-autoupdate", "run"],
                networks: [PROXY_NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [PROXY_NETWORK]
    };
}

/**
 * Save the connector token + hostname and bring up the named-tunnel sidecar.
 * Recreated cleanly so a re-run always picks up a rotated token. The tunnel stays
 * up across restarts (restart: unless-stopped) and reconnects on reboot.
 */
export async function startNamedTunnel(
    appId: string,
    ownerId: string,
    input: { token: string; hostname: string }
): Promise<NamedTunnelStatus> {
    await requireLocalApp(appId, ownerId);
    const token = input.token.trim();
    const hostname = input.hostname.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!token) throw new Error("Paste the tunnel connector token from Cloudflare");
    if (!hostname) throw new Error("Enter the hostname you mapped to this tunnel");

    await storeToken(appId, token);
    await setSetting(hostKey(appId), hostname);

    const { project, service } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, token));
    } finally {
        await ports.dispose();
    }
    return { running: true, hostname, configured: true };
}

/** Tear down the named-tunnel sidecar and forget its token + hostname. Idempotent. */
export async function stopNamedTunnel(appId: string, ownerId: string): Promise<void> {
    await requireLocalApp(appId, ownerId);
    const { project } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
    } finally {
        await ports.dispose();
    }
    await setSetting(tokenKey(appId), null);
    await setSetting(hostKey(appId), null);
}

/** Whether the named tunnel is configured, its hostname, and whether the sidecar
 *  is currently running. Best-effort: a hostd hiccup reports not-running. */
export async function getNamedTunnelStatus(appId: string, ownerId: string): Promise<NamedTunnelStatus> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");

    const [hostname, token] = await Promise.all([getSetting(hostKey(appId)), loadToken(appId)]);
    const configured = Boolean(token);
    if (!configured) return { running: false, hostname, configured: false };

    const { service } = names(appId);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean } };
        return { running: Boolean(info?.State?.Running), hostname, configured: true };
    } catch {
        return { running: false, hostname, configured: true };
    } finally {
        await ports.dispose();
    }
}
