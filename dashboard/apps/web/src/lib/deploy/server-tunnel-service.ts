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
    quoteArgv,
    parseTunnelSetup,
    reverseTunnelArgv,
    reverseTunnelConfig,
    reverseTunnelName,
    reverseTunnelPort,
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
const bindKey = (hostId: string): string => `deploy.stunnel.bind.${hostId}`;
/** One row per claimed port, so the unique key on it is the allocation lock. */
const portRowKey = (hostId: string, port: number): string => `deploy.stunnel.port.${hostId}.${port}`;
const appPortKey = (hostId: string, appId: string): string => `deploy.stunnel.appport.${hostId}.${appId}`;

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

/** Load an app the caller owns. Every entry point here starts with this: the hostname
 *  a tunnel publishes on is not something another owner's account may read or move. */
async function requireOwnedApp(appId: string, ownerId: string): Promise<{ id: string; slug: string; local: boolean }> {
    const app = await prisma.application.findFirst({
        where: { id: appId, environment: { project: { ownerId } } },
        include: { target: true }
    });
    if (!app) throw new Error("Application not found");
    return { id: app.id, slug: app.slug, local: app.target.kind === "local" };
}

/** The same, for the paths that bring a tunnel up: the tunnel client runs beside the
 *  service, so the app must be deployed on this box; a remote one is already routable. */
async function requireLocalApp(appId: string, ownerId: string): Promise<{ id: string; slug: string }> {
    const app = await requireOwnedApp(appId, ownerId);
    if (!app.local) {
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
 * Prepare the server once: mint the tunnel key, authorize it restricted to port
 * forwarding, allow a forward to bind off loopback, and learn where it has to bind -
 * the server's own Docker gateway, which is not the stock address on a daemon with a
 * custom `bip`, rootless Docker or Podman. Cached per server; the setup script is
 * idempotent, so a server that only misses the bind address re-runs it safely.
 */
async function ensureTunnelServer(hostId: string, ownerId: string): Promise<{ key: string; bindAddress: string }> {
    const [cachedKey, cachedBind] = await Promise.all([loadKey(hostId), getSetting(bindKey(hostId))]);
    if (cachedKey && cachedBind) return { key: cachedKey, bindAddress: cachedBind };
    const connection = await getHostConnection(hostId, ownerId);
    const { stdout, code } = await onServer(connection, tunnelSetupScript());
    const parsed = parseTunnelSetup(stdout);
    const key = cachedKey ?? parsed.key;
    if (code !== 0 || !key) {
        throw new Error("Could not set up the tunnel key on that server. Check it is onboarded and reachable.");
    }
    if (!cachedKey) await storeKey(hostId, key);
    await setSetting(bindKey(hostId), parsed.bindAddress);
    return { key, bindAddress: parsed.bindAddress };
}

/**
 * The app's forwarded port on that server, allocated on first use and kept from then
 * on. Two tunnels must never share one: the second `ssh -R` cannot bind and exits,
 * while its route still points at the port the first is holding - so its hostname
 * would serve the other app's service to whoever knows the name.
 *
 * Each port is claimed by inserting a row keyed on it, so the database's unique key
 * decides who gets it. A read-modify-write over one shared row cannot: two starts
 * against the same server interleave, both read the same reservations, and the later
 * write drops the earlier one - which is exactly the collision this prevents.
 */
async function allocatePort(hostId: string, appId: string): Promise<number> {
    const existing = Number(await getSetting(appPortKey(hostId, appId)));
    if (Number.isInteger(existing) && existing > 0) return existing;

    const tried: number[] = [];
    for (let attempt = 0; attempt < 64; attempt += 1) {
        const port = reverseTunnelPort(appId, tried);
        try {
            await prisma.setting.create({
                data: { key: portRowKey(hostId, port), value: appId, scope: "global" }
            });
        } catch (caught) {
            // Taken by another app (unique key). Ours only if this is a retry of a
            // half-finished allocation, in which case the port is already ours.
            const owner = await getSetting(portRowKey(hostId, port));
            if (owner !== appId) {
                tried.push(port);
                continue;
            }
            void caught;
        }
        await setSetting(appPortKey(hostId, appId), String(port));
        return port;
    }
    throw new Error("That server has no free tunnel port left");
}

/** Hand the port back, so a server does not fill up with reservations for apps whose
 *  tunnels are long gone. */
async function releasePort(hostId: string, appId: string): Promise<void> {
    const port = await getSetting(appPortKey(hostId, appId));
    if (!port) return;
    // Only if it is still ours: an already-recycled port now belongs to another app.
    if ((await getSetting(portRowKey(hostId, Number(port)))) === appId) {
        await setSetting(portRowKey(hostId, Number(port)), null);
    }
    await setSetting(appPortKey(hostId, appId), null);
}

/**
 * Drop everything a tunnel left on its server: the Traefik route and the port
 * reservation. Best-effort on the route - an unreachable server must not block tearing
 * a tunnel down, and its route points at a port nothing answers on once the tunnel is
 * gone - but the reservation is local, so it is always released.
 */
async function dropRemoteRoute(hostId: string, appId: string, ownerId: string): Promise<void> {
    await getHostConnection(hostId, ownerId)
        .then((connection) => onServer(connection, `rm -f ${DYNAMIC_DIR}/${reverseTunnelName(appId)}.yml`))
        .catch(() => undefined);
    await releasePort(hostId, appId);
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
                // `$$` is compose's escape for a literal `$`: the command goes into a
                // compose file, and compose substitutes variables in it before Docker
                // ever runs anything. Unescaped, POLARIS_TUNNEL_KEY (which lives in the
                // container's environment, not the daemon's) would be replaced with an
                // empty string and the sidecar would write an empty key file.
                command: [
                    "sh",
                    "-c",
                    `umask 077; printf '%s' "$$POLARIS_TUNNEL_KEY" | base64 -d > ${KEY_PATH}; exec ${quoteArgv(argv)}`
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

    // The hostname is keyed on the app id, not just its slug: slugs are only unique
    // within an environment, so two services called "api" in different projects would
    // otherwise mint the same name on one server and the second would quietly take
    // over the first's traffic.
    const hostname = `${app.slug}-${shortHash(appId, 6)}.${server.domain}`;
    const { key, bindAddress } = await ensureTunnelServer(server.id, ownerId);
    const remotePort = await allocatePort(server.id, appId);
    const spec = { appId, hostname, localHost: localIp, localPort: hostPortForApp(appId), remotePort, bindAddress };
    const connection = await getHostConnection(server.id, ownerId);

    // Moving an app to another server leaves the old one answering that hostname from
    // a forward nothing dials any more; it is dropped before the new one takes over.
    const previous = await getSetting(serverKey(appId));
    if (previous && previous !== server.id) await dropRemoteRoute(previous, appId, ownerId);

    // The route first: the forward is useless until the server knows what to do with
    // it, and a failure here leaves nothing running to clean up.
    const config = Buffer.from(reverseTunnelConfig(spec), "utf8").toString("base64");
    const file = `${DYNAMIC_DIR}/${reverseTunnelName(appId)}.yml`;
    // A server onboarded before tunnel support runs a Traefik with no file provider: it
    // never reads the route, so writing one would succeed and the hostname would answer
    // 404 forever. Checked here rather than assumed, and said plainly.
    const traefik = await onServer(
        connection,
        "docker inspect polaris-traefik --format '{{json .Config.Cmd}}' 2>/dev/null || true"
    );
    if (!traefik.stdout.includes("providers.file.directory")) {
        await releasePort(server.id, appId);
        throw new Error(
            `Traefik on ${server.name} was started before tunnel support. Re-run onboarding on that server, then try again.`
        );
    }

    const write = await onServer(connection, `mkdir -p ${DYNAMIC_DIR} && echo ${config} | base64 -d > ${file}`);
    if (write.code !== 0) {
        await releasePort(server.id, appId);
        throw new Error("Could not write the route on that server");
    }

    const argv = reverseTunnelArgv(spec, {
        host: connection.address,
        port: connection.port,
        username: connection.username,
        keyPath: KEY_PATH
    });
    const { project, service } = names(appId);
    // Recorded before the sidecar comes up: from here the server carries a route only
    // this app's teardown knows how to remove, so a start that fails halfway must still
    // be able to find it - otherwise the hostname is left answering forever.
    await setSetting(hostKey(appId), hostname);
    await setSetting(serverKey(appId), server.id);
    const ports = new HostdPorts();
    let running = false;
    try {
        await ports.composeDown(project).catch(() => undefined);
        await ports.composeUp(tunnelSpec(project, service, argv, Buffer.from(key, "utf8").toString("base64")));
        // Up is not the same as forwarding: sshd refuses a non-loopback bind unless
        // GatewayPorts was actually applied (the setup script cannot force it when sudo
        // needs a password), and `ExitOnForwardFailure` then kills ssh on every dial. So
        // the sidecar is given a moment and asked whether it is still alive, rather than
        // reporting a tunnel that is quietly restart-looping.
        running = await settled(ports, service);
    } catch (caught) {
        // A start that never got off the ground leaves nothing behind: the route on the
        // operator's server and the port reservation both go with it.
        await ports.composeDown(project).catch(() => undefined);
        await dropRemoteRoute(server.id, appId, ownerId);
        await setSetting(hostKey(appId), null);
        await setSetting(serverKey(appId), null);
        throw caught;
    } finally {
        await ports.dispose();
    }

    return { configured: true, running, hostname, serverName: server.name };
}

/** Whether the sidecar is still running a few seconds after it started - long enough
 *  for a refused forward to have taken it down. */
async function settled(ports: HostdPorts, service: string): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    try {
        const info = (await ports.inspect(service)) as { State?: { Running?: boolean; Restarting?: boolean } };
        return Boolean(info?.State?.Running) && !info.State?.Restarting;
    } catch {
        return false;
    }
}

/** Tear the tunnel down and drop the route it left on the server. Idempotent. */
export async function stopServerTunnel(appId: string, ownerId: string): Promise<void> {
    // Ownership only: an app moved to another server after its tunnel was published
    // still has to be able to take that hostname back down.
    await requireOwnedApp(appId, ownerId);
    const { project } = names(appId);
    const ports = new HostdPorts();
    try {
        await ports.composeDown(project).catch(() => undefined);
    } finally {
        await ports.dispose();
    }
    const hostId = await getSetting(serverKey(appId));
    if (hostId) await dropRemoteRoute(hostId, appId, ownerId);
    await setSetting(hostKey(appId), null);
    await setSetting(serverKey(appId), null);
}

/** Whether the app's tunnel sidecar is up, and the hostname it publishes. */
export async function getServerTunnelStatus(appId: string, ownerId: string): Promise<ServerTunnelStatus> {
    await requireOwnedApp(appId, ownerId);
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
