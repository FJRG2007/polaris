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
import { getPublicIp } from "../domain-service";
import { hostPortForApp } from "../deploy-service";
import {
    createTunnel,
    deleteDnsRecord,
    deleteTunnel,
    getTunnelToken,
    putTunnelIngress,
    putTunnelPlaceholder,
    resolveZoneForHostname,
    upsertTunnelCname
} from "../integrations/cloudflare-api";
import { requireCloudflareAccount } from "../integrations/cloudflare-account-service";
import { HostdPorts } from "./ports-hostd";

const PROXY_NETWORK = "polaris-proxy";
const IMAGE = "cloudflare/cloudflared:latest";

export interface NamedTunnelStatus {
    running: boolean;
    /** The configured stable hostname, when set. */
    hostname: string | null;
    /** Whether a connector token is stored (so the UI can offer start/stop). */
    configured: boolean;
    /** True when Polaris created the tunnel + DNS itself via the Cloudflare API. */
    managed: boolean;
    /** Whether the tunnel currently routes to the app (off = name reserved, not served). */
    enabled: boolean;
}

/** Cloudflare resources Polaris created for a managed tunnel, kept for teardown. */
interface ManagedRefs {
    tunnelId: string;
    zoneId: string;
    dnsId: string;
    accountId: string;
}

/** Compose project/service names for an app's named tunnel (charset-safe for hostd). */
function names(appId: string): { project: string; service: string } {
    const hash = shortHash(appId, 8);
    return { project: `polaris-ntunnel-${hash}`, service: `ntunnel-${hash}` };
}

const tokenKey = (appId: string): string => `deploy.ntunnel.${appId}.token`;
const hostKey = (appId: string): string => `deploy.ntunnel.${appId}.hostname`;
const managedKey = (appId: string): string => `deploy.ntunnel.${appId}.managed`;
const enabledKey = (appId: string): string => `deploy.ntunnel.${appId}.disabled`;

/** Whether the tunnel routes to the app. Stored as a "disabled" flag so the default
 *  (no row) reads as enabled; a value of "1" means the operator turned it off. */
async function isEnabled(appId: string): Promise<boolean> {
    return (await getSetting(enabledKey(appId))) !== "1";
}

/** Normalize a hostname the same way the manual and automated flows expect. */
function normalizeHost(hostname: string): string {
    return hostname
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "")
        .toLowerCase();
}

async function loadManaged(appId: string): Promise<ManagedRefs | null> {
    const raw = await getSetting(managedKey(appId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as ManagedRefs;
        return typeof parsed?.tunnelId === "string" ? parsed : null;
    } catch {
        return null;
    }
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
    // A manually pasted token is not Polaris-managed; drop any stale managed refs.
    await setSetting(managedKey(appId), null);
    await setSetting(enabledKey(appId), null);

    const { project, service } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, token));
    } finally {
        await ports.dispose();
    }
    return { running: true, hostname, configured: true, managed: false, enabled: true };
}

/**
 * Automated named tunnel: with a connected Cloudflare API token, create the tunnel,
 * push its ingress to this app's origin, and point a proxied DNS record at it - the
 * operator only supplies the hostname. The origin is the app's published host port
 * (the same IP:port the manual instructions use). Idempotent per hostname: the DNS
 * record is upserted; a fresh tunnel replaces any previous managed one for this app.
 */
export async function provisionNamedTunnel(
    appId: string,
    ownerId: string,
    input: { hostname: string }
): Promise<NamedTunnelStatus> {
    await requireLocalApp(appId, ownerId);
    const hostname = normalizeHost(input.hostname);
    if (!hostname) throw new Error("Enter the hostname you want to use");

    const { token, accountId } = await requireCloudflareAccount();
    const zone = await resolveZoneForHostname(token, hostname);

    const originIp = await getPublicIp();
    if (!originIp) throw new Error("This server has no reachable IP to route the tunnel to");
    const originUrl = `http://${originIp}:${hostPortForApp(appId)}`;

    // Retire a previous managed tunnel for this app before creating the new one, so
    // repeated provisioning does not leak tunnels in the operator's account.
    const previous = await loadManaged(appId);

    const tunnel = await createTunnel(token, accountId, `polaris-${shortHash(appId, 8)}`);
    const connectorToken = await getTunnelToken(token, accountId, tunnel.id);
    await putTunnelIngress(token, accountId, tunnel.id, hostname, originUrl);
    const dnsId = await upsertTunnelCname(token, zone.id, hostname, tunnel.id);

    await storeToken(appId, connectorToken);
    await setSetting(hostKey(appId), hostname);
    await setSetting(enabledKey(appId), null);
    await setSetting(
        managedKey(appId),
        JSON.stringify({ tunnelId: tunnel.id, zoneId: zone.id, dnsId, accountId } satisfies ManagedRefs)
    );

    const { project, service } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, connectorToken));
    } finally {
        await ports.dispose();
    }

    if (previous && previous.tunnelId !== tunnel.id) {
        // Best-effort: the old connector is gone, so the tunnel can be deleted.
        await deleteTunnel(token, previous.accountId, previous.tunnelId).catch(() => undefined);
    }
    return { running: true, hostname, configured: true, managed: true, enabled: true };
}

/**
 * Turn an app's named tunnel on or off while keeping its name reserved. Enabling
 * routes the hostname back to the app; disabling stops serving it without deleting
 * the tunnel. For a Polaris-managed tunnel, disabling repoints the Cloudflare
 * ingress at a placeholder (so the connector stays up and the hostname/DNS stay
 * reserved instead of disconnecting); a manual tunnel just stops its connector.
 */
export async function setNamedTunnelEnabled(appId: string, ownerId: string, enabled: boolean): Promise<void> {
    await requireLocalApp(appId, ownerId);
    const [hostname, token, managed] = await Promise.all([getSetting(hostKey(appId)), loadToken(appId), loadManaged(appId)]);
    if (!token || !hostname) throw new Error("This app has no named tunnel configured");

    const { project, service } = names(appId);
    const ports = new HostdPorts();
    try {
        if (managed) {
            const account = await requireCloudflareAccount();
            if (enabled) {
                const originIp = await getPublicIp();
                if (!originIp) throw new Error("This server has no reachable IP to route the tunnel to");
                await putTunnelIngress(account.token, account.accountId, managed.tunnelId, hostname, `http://${originIp}:${hostPortForApp(appId)}`);
            } else {
                await putTunnelPlaceholder(account.token, account.accountId, managed.tunnelId, hostname);
            }
            // Keep the connector running either way so the hostname stays reserved.
            await ports.composeUp(tunnelSpec(project, service, token));
        } else if (enabled) {
            await ports.composeUp(tunnelSpec(project, service, token));
        } else {
            // No API access to repoint a manual tunnel's ingress; stop its connector.
            await ports.composeDown(project).catch(() => undefined);
        }
    } finally {
        await ports.dispose();
    }
    await setSetting(enabledKey(appId), enabled ? null : "1");
}

/** Tear down the named-tunnel sidecar and forget its token + hostname. For a
 *  Polaris-managed tunnel, also remove the DNS record and tunnel it created in the
 *  operator's Cloudflare account (best-effort, so a hiccup never blocks teardown). */
export async function stopNamedTunnel(appId: string, ownerId: string): Promise<void> {
    await requireLocalApp(appId, ownerId);
    const managed = await loadManaged(appId);

    const { project } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
    } finally {
        await ports.dispose();
    }

    if (managed) {
        const { token } = await requireCloudflareAccount().catch(() => ({ token: null as string | null }));
        if (token) {
            await deleteDnsRecord(token, managed.zoneId, managed.dnsId).catch(() => undefined);
            // The connector is down now, so the tunnel can be deleted.
            await deleteTunnel(token, managed.accountId, managed.tunnelId).catch(() => undefined);
        }
    }

    await setSetting(tokenKey(appId), null);
    await setSetting(hostKey(appId), null);
    await setSetting(managedKey(appId), null);
    await setSetting(enabledKey(appId), null);
}

/** Whether the named tunnel is configured, its hostname, and whether the sidecar
 *  is currently running. Best-effort: a hostd hiccup reports not-running. */
export async function getNamedTunnelStatus(appId: string, ownerId: string): Promise<NamedTunnelStatus> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");

    const [hostname, token, managed, enabled] = await Promise.all([
        getSetting(hostKey(appId)),
        loadToken(appId),
        loadManaged(appId),
        isEnabled(appId)
    ]);
    const configured = Boolean(token);
    const isManaged = Boolean(managed);
    if (!configured) return { running: false, hostname, configured: false, managed: isManaged, enabled };

    const { service } = names(appId);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean } };
        return { running: Boolean(info?.State?.Running), hostname, configured: true, managed: isManaged, enabled };
    } catch {
        return { running: false, hostname, configured: true, managed: isManaged, enabled };
    } finally {
        await ports.dispose();
    }
}
