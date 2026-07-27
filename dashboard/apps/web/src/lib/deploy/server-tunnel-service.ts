/**
 * Per-app reverse SSH tunnels through a server the operator already owns. This is
 * how a box behind carrier NAT publishes a service on its own domain without any
 * tunnel provider: a sidecar here dials out with `ssh -R` to a registered server,
 * that server's Traefik routes the hostname to the forwarded port, and it issues the
 * certificate. The data path is the sidecar and the operator's own server - Polaris
 * itself is never in it, so a restart of the dashboard does not drop published apps.
 *
 * The tunnel authenticates with a dedicated key minted on the target server (the
 * operator's own SSH credentials never leave Polaris), stored envelope-encrypted with
 * the master key like every other secret here.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { execCommand, openSshClient } from "@polaris/ssh";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    magicDomain,
    quoteArgv,
    reverseTunnelArgv,
    reverseTunnelConfig,
    reverseTunnelName,
    shortHash,
    tunnelSetupScript,
    type ComposeSpec
} from "@polaris/deploy";
import { HostdPorts } from "./ports-hostd";
import { getPublicIp } from "../domain-service";
import { hostPortForApp } from "../deploy-service";
import { getHostConnection } from "../host-service";
import { getSetting, setSetting } from "../setting-store";

const PROXY_NETWORK = "polaris-proxy";
/**
 * Docker Official Image that ships an OpenSSH client, so the sidecar needs no
 * package install at start (a tunnel must come back up on a rebooted, possibly
 * offline-ish box without reaching a package registry first).
 */
const IMAGE = "buildpack-deps:bookworm-scm";
/** Where the tunnel key is written inside the sidecar. */
const KEY_PATH = "/tmp/polaris_tunnel";
/** Traefik's dynamic-config directory on a Polaris-onboarded server. */
const DYNAMIC_DIR = "/var/lib/polaris/traefik/dynamic";

export interface ServerTunnelStatus {
    /** Whether some registered server can terminate tunnels (has a wildcard domain). */
    configured: boolean;
    running: boolean;
    /** The stable public hostname, when a tunnel has been set up. */
    hostname: string | null;
    /** The server publishing it. */
    serverName: string | null;
}

/** Compose project/service names for an app's tunnel (charset-safe for hostd). */
function names(appId: string): { project: string; service: string } {
    const hash = shortHash(appId, 8);
    return { project: `polaris-stunnel-${hash}`, service: `stunnel-${hash}` };
}

const hostKey = (appId: string): string => `deploy.stunnel.${appId}.hostname`;
const serverKey = (appId: string): string => `deploy.stunnel.${appId}.hostId`;
const keyKey = (hostId: string): string => `deploy.stunnel.key.${hostId}`;

/** Servers that can publish a tunnel: registered, and with a wildcard domain whose
 *  `*` record the operator pointed at them. */
export async function listTunnelServers(ownerId: string): Promise<Array<{ id: string; name: string; domain: string }>> {
    const hosts = await prisma.host.findMany({
        where: { ownerId, status: "active", NOT: { wildcardDomain: null } },
        select: { id: true, name: true, wildcardDomain: true },
        orderBy: { createdAt: "asc" }
    });
    return hosts.map((host) => ({ id: host.id, name: host.name, domain: host.wildcardDomain ?? "" }));
}

/** Load an app the caller owns. The tunnel client runs beside the service, so the
 *  app must be deployed on this box; a remote one is already publicly routable. */
async function requireLocalApp(appId: string, ownerId: string): Promise<{ id: string; slug: string }> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        include: { target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("A server tunnel publishes a service running on this box; this one runs on another server");
    }
    return { id: app.id, slug: app.slug };
}

async function storeKey(hostId: string, key: string): Promise<void> {
    const blob = encryptSecret(key, loadEnv().POLARIS_MASTER_KEY);
    await setSetting(
        keyKey(hostId),
        JSON.stringify({ c: blob.ciphertext.toString("base64"), n: blob.nonce.toString("base64"), k: blob.keyId })
    );
}

async function loadKey(hostId: string): Promise<string | null> {
    const raw = await getSetting(keyKey(hostId));
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

/** Run one command on the target server and return its stdout. */
async function onServer(
    connection: Awaited<ReturnType<typeof getHostConnection>>,
    command: string
): Promise<{ stdout: string; code: number }> {
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    let stdout = "";
    try {
        const result = await execCommand(client, command, { onStdout: (chunk) => (stdout += chunk.toString("utf8")) });
        return { stdout, code: result.code };
    } finally {
        client.end();
    }
}

/**
 * Prepare the server once: mint the tunnel key, authorize it, and allow a forward to
 * bind off loopback. Cached - the key is only minted on the first tunnel to a server.
 */
async function ensureTunnelKey(hostId: string, ownerId: string): Promise<string> {
    const cached = await loadKey(hostId);
    if (cached) return cached;
    const connection = await getHostConnection(hostId, ownerId);
    const { stdout, code } = await onServer(connection, tunnelSetupScript());
    const key = stdout.slice(stdout.indexOf("-----BEGIN")).trim();
    if (code !== 0 || !key.startsWith("-----BEGIN")) {
        throw new Error("Could not set up the tunnel key on that server. Check it is onboarded and reachable.");
    }
    await storeKey(hostId, key);
    return key;
}

/** The sidecar: write the key, then hold the reverse forward open. */
function tunnelSpec(project: string, service: string, argv: string[], keyB64: string): ComposeSpec {
    return {
        project,
        services: [
            {
                name: service,
                image: IMAGE,
                // Base64 so the key stays one line through compose rendering; the
                // sidecar decodes it to a 0600 file the ssh client can use.
                env: { POLARIS_TUNNEL_KEY: keyB64 },
                ports: [],
                volumes: [],
                labels: {},
                command: [
                    "sh",
                    "-c",
                    `umask 077; printf '%s' "$POLARIS_TUNNEL_KEY" | base64 -d > ${KEY_PATH}; exec ${quoteArgv(argv)}`
                ],
                networks: [PROXY_NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [PROXY_NETWORK]
    };
}

/**
 * Publish an app through a server tunnel. Idempotent per app: re-running replaces the
 * sidecar and rewrites the server's route, so a rotated key or a moved app is picked
 * up. Returns the hostname the server will answer for.
 */
export async function startServerTunnel(
    appId: string,
    ownerId: string,
    input: { hostId?: string } = {}
): Promise<ServerTunnelStatus> {
    const app = await requireLocalApp(appId, ownerId);
    const servers = await listTunnelServers(ownerId);
    const server = input.hostId ? servers.find((entry) => entry.id === input.hostId) : servers[0];
    if (!server) {
        throw new Error("No server can publish tunnels yet. Give one a wildcard domain under Servers first.");
    }
    const localIp = await getPublicIp();
    if (!localIp) throw new Error("This box has no address to forward the tunnel to");

    const hostname = magicDomain(app.slug, "", server.domain);
    const spec = { appId, hostname, localHost: localIp, localPort: hostPortForApp(appId) };
    const key = await ensureTunnelKey(server.id, ownerId);
    const connection = await getHostConnection(server.id, ownerId);

    // The route first: the forward is useless until the server knows what to do with
    // it, and a failure here leaves nothing running to clean up.
    const config = Buffer.from(reverseTunnelConfig(spec), "utf8").toString("base64");
    const file = `${DYNAMIC_DIR}/${reverseTunnelName(appId)}.yml`;
    const write = await onServer(connection, `mkdir -p ${DYNAMIC_DIR} && echo ${config} | base64 -d > ${file}`);
    if (write.code !== 0) throw new Error("Could not write the route on that server");

    const argv = reverseTunnelArgv(spec, {
        host: connection.address,
        port: connection.port,
        username: connection.username,
        keyPath: KEY_PATH
    });
    const { project, service } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, argv, Buffer.from(key, "utf8").toString("base64")));
    } finally {
        await ports.dispose();
    }

    await setSetting(hostKey(appId), hostname);
    await setSetting(serverKey(appId), server.id);
    return { configured: true, running: true, hostname, serverName: server.name };
}

/** Tear the tunnel down and drop the route it left on the server. Idempotent. */
export async function stopServerTunnel(appId: string, ownerId: string): Promise<void> {
    await requireLocalApp(appId, ownerId);
    const { project } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
    } finally {
        await ports.dispose();
    }
    const hostId = await getSetting(serverKey(appId));
    if (hostId) {
        // Best-effort: an unreachable server must not block tearing the sidecar down,
        // and its route points at a port nothing answers on once the tunnel is gone.
        await getHostConnection(hostId, ownerId)
            .then((connection) => onServer(connection, `rm -f ${DYNAMIC_DIR}/${reverseTunnelName(appId)}.yml`))
            .catch(() => undefined);
    }
    await setSetting(hostKey(appId), null);
    await setSetting(serverKey(appId), null);
}

/** Whether the app's tunnel sidecar is up, and the hostname it publishes. */
export async function getServerTunnelStatus(appId: string, ownerId: string): Promise<ServerTunnelStatus> {
    const servers = await listTunnelServers(ownerId);
    const [hostname, hostId] = await Promise.all([getSetting(hostKey(appId)), getSetting(serverKey(appId))]);
    const server = servers.find((entry) => entry.id === hostId);
    if (!hostname) return { configured: servers.length > 0, running: false, hostname: null, serverName: null };

    const { service } = names(appId);
    const ports = new HostdPorts();
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean } };
        return {
            configured: true,
            running: Boolean(info?.State?.Running),
            hostname,
            serverName: server?.name ?? null
        };
    } catch {
        return { configured: true, running: false, hostname, serverName: server?.name ?? null };
    } finally {
        await ports.dispose();
    }
}
