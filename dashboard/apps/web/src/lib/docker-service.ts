/**
 * Server-side Docker service. Turns a stored Docker connection into a live driver
 * (decrypting any secret transport material with the shared credential crypto),
 * and persists connections. The common local case - the socket or the
 * install-provisioned SSH key - carries no stored secret at all.
 */

import { prisma } from "@polaris/db";
import { readFileSync } from "node:fs";
import { loadEnv } from "@polaris/config";
import type { SshAuth } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { getHostConnection } from "./host-service";
import { HostdClient } from "@polaris/hostd-client";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import type { DockerConfig, DockerCredentials, DockerRpc } from "@polaris/docker";
import {
    createDockerDriver,
    DockerDriver,
    sshTransport,
    streamRpc,
    type DockerConnectionRecord
} from "@polaris/docker";

/**
 * Reserved id of the auto-provisioned local host. It is not a stored row: it is
 * reached through polaris-hostd's allowlisted Docker proxy, so the web container
 * never touches the socket itself. Callers must authorize it (system.manage) -
 * it is host-wide, not owner-scoped.
 */
export const LOCAL_DOCKER_CONNECTION_ID = "local";

/**
 * Driver for the local host, brokered by polaris-hostd. Every call is forwarded
 * through the daemon's `/v1/docker` allowlist; there is no transport to close.
 */
export function localDockerDriver(): DockerDriver {
    const client = new HostdClient();
    const rpc: DockerRpc = {
        // Everything the proxy allows answers with JSON or nothing at all, so the
        // daemon's text envelope is the whole reply. No `hijack`: the daemon
        // brokers one bounded call at a time and has its own exec endpoint, which
        // is what the local console and file browser use instead.
        request: async (method, path) => {
            const response = await client.dockerRequest(method, path);
            return {
                status: response.status,
                body: response.body,
                bytes: Buffer.from(response.body, "utf8")
            };
        },
        dispose: async () => undefined
    };
    return new DockerDriver(rpc);
}

export async function listDockerConnections(ownerId: string) {
    return prisma.dockerConnection.findMany({
        where: { ownerId },
        select: { id: true, name: true, transport: true, status: true, createdAt: true },
        orderBy: { createdAt: "asc" }
    });
}

/** Load a stored connection scoped to its owner and decrypt whatever secret
 *  material it carries. A socket or install-key connection has none. */
async function loadDockerConnection(
    connectionId: string,
    ownerId: string
): Promise<{ id: string; config: DockerConfig; credentials: DockerCredentials }> {
    const row = await prisma.dockerConnection.findFirst({ where: { id: connectionId, ownerId } });
    if (!row) throw new Error("Docker connection not found");
    const config = JSON.parse(row.config) as DockerConfig;
    const credentials: DockerCredentials =
        row.encryptedCredential && row.credentialNonce
            ? decryptCredentials(
                  {
                      ciphertext: Buffer.from(row.encryptedCredential),
                      nonce: Buffer.from(row.credentialNonce),
                      keyId: row.credentialKeyId ?? ""
                  },
                  loadEnv().POLARIS_MASTER_KEY
              )
            : ({ transport: config.transport } as DockerCredentials);
    return { id: row.id, config, credentials };
}

export async function getDockerDriver(connectionId: string, ownerId: string) {
    const record: DockerConnectionRecord = await loadDockerConnection(connectionId, ownerId);
    return createDockerDriver(record, {
        borrowSsh: (key, options) => borrowSsh("docker", key, options)
    });
}

export async function createDockerConnection(
    ownerId: string,
    name: string,
    config: DockerConfig,
    credentials: DockerCredentials
) {
    const hasSecret = Object.keys(credentials).some((key) => key !== "transport");
    const blob = hasSecret ? encryptCredentials(credentials, loadEnv().POLARIS_MASTER_KEY) : null;
    return prisma.dockerConnection.create({
        data: {
            ownerId,
            name,
            transport: config.transport,
            config: JSON.stringify(config),
            encryptedCredential: blob?.ciphertext ?? null,
            credentialNonce: blob?.nonce ?? null,
            credentialKeyId: blob?.keyId ?? null
        },
        select: { id: true }
    });
}

export async function deleteDockerConnection(ownerId: string, connectionId: string) {
    await prisma.dockerConnection.deleteMany({ where: { id: connectionId, ownerId } });
}

/** Prefix marking a Containers connection id that resolves to a global Host
 *  (Docker over SSH), so the app can route it without a separate lookup. */
export const HOST_DOCKER_PREFIX = "host:";

/** Docker driver for a global Host, over SSH via the shared, pinned primitive. */
export async function hostDockerDriver(hostId: string, ownerId: string): Promise<DockerDriver> {
    const conn = await getHostConnection(hostId, ownerId);
    const options = hostSshTransportOptions(conn);
    // Borrowed from the pool: listing containers, reading stats and following logs
    // are separate calls to the same machine, and each one opening its own SSH
    // connection is most of what they cost.
    return new DockerDriver(
        streamRpc(sshTransport({ ...options, borrow: () => borrowSsh("docker", conn.id, options) }))
    );
}

/**
 * Whether a Containers connection resolves to something this user owns.
 *
 * Opening a driver proves this on its own - every resolver above is owner-scoped
 * - so a caller that reaches the engine needs nothing else. A caller that
 * answers from a cache instead never resolves anything, and ownership has to be
 * established here or not at all. The local host is not owned by anyone: it is
 * host-wide, and its caller gates it on system.manage.
 */
export async function ownsDockerConnection(
    connectionId: string,
    ownerId: string
): Promise<boolean> {
    if (connectionId === LOCAL_DOCKER_CONNECTION_ID) return true;
    if (connectionId.startsWith(HOST_DOCKER_PREFIX)) {
        const host = await prisma.host.findFirst({
            where: { id: connectionId.slice(HOST_DOCKER_PREFIX.length), ownerId },
            select: { id: true }
        });
        return host !== null;
    }
    const connection = await prisma.dockerConnection.findFirst({
        where: { id: connectionId, ownerId },
        select: { id: true }
    });
    return connection !== null;
}

function hostSshTransportOptions(conn: Awaited<ReturnType<typeof getHostConnection>>) {
    return {
        host: conn.address,
        port: conn.port,
        username: conn.username,
        auth: conn.auth,
        pinnedHostKey: conn.hostKey
    };
}

/**
 * A Docker connection resolved down to the material needed to open a transport,
 * with every secret already decrypted. Only the terminal sidecar consumes this:
 * it runs outside the Next bundle, so it can neither reach the master key nor
 * read the mounted install key's known_hosts, and it must be handed a target it
 * can connect to verbatim.
 */
export type DockerTransportTarget =
    | { transport: "socket"; socketPath: string }
    | {
          transport: "tcp";
          host: string;
          port: number;
          tls: boolean;
          ca?: string;
          cert?: string;
          key?: string;
      }
    | {
          transport: "ssh";
          host: string;
          port: number;
          username: string;
          auth: SshAuth;
          pinnedHostKey: string[];
      };

/**
 * Resolve a Containers connection id to that target. The local host has no
 * transport of its own - it is brokered by the daemon - so it is refused here
 * rather than silently handed a socket the web container is deliberately not
 * given. Owner-scoped through the same resolvers the drivers use.
 */
export async function resolveDockerTransport(
    connectionId: string,
    ownerId: string
): Promise<DockerTransportTarget> {
    if (connectionId === LOCAL_DOCKER_CONNECTION_ID) {
        throw new Error(
            "The local host is reached through the host daemon, not a Docker transport"
        );
    }
    if (connectionId.startsWith(HOST_DOCKER_PREFIX)) {
        const conn = await getHostConnection(
            connectionId.slice(HOST_DOCKER_PREFIX.length),
            ownerId
        );
        // An empty pin list is what the SSH client refuses outright. A registered
        // server always has its key captured at enrollment, so this is a broken
        // row rather than a case to connect blind for.
        if (!conn.hostKey) throw new Error("This server has no pinned key to verify it with");
        return {
            transport: "ssh",
            host: conn.address,
            port: conn.port,
            username: conn.username,
            auth: conn.auth,
            pinnedHostKey: [conn.hostKey]
        };
    }

    const { config, credentials } = await loadDockerConnection(connectionId, ownerId);
    switch (config.transport) {
        case "socket":
            return { transport: "socket", socketPath: config.socketPath };
        case "tcp": {
            const creds = credentials as Extract<DockerCredentials, { transport: "tcp" }>;
            return {
                transport: "tcp",
                host: config.host,
                port: config.port,
                tls: config.tls,
                ca: creds.ca,
                cert: creds.cert,
                key: creds.key
            };
        }
        case "ssh": {
            const env = loadEnv();
            const creds = credentials as Extract<DockerCredentials, { transport: "ssh" }>;
            const privateKey = config.useInstallKey
                ? readFileSync(env.POLARIS_SSH_KEY, "utf8")
                : (creds.privateKey ?? "");
            if (!privateKey) throw new Error("SSH connection has no private key");
            const pinnedHostKey = pinnedKeysFor(
                readFileSync(env.POLARIS_SSH_KNOWN_HOSTS, "utf8"),
                config.host,
                config.port
            );
            if (pinnedHostKey.length === 0)
                throw new Error("This host has no pinned key to verify it with");
            return {
                transport: "ssh",
                host: config.host,
                port: config.port,
                username: config.username,
                auth: { method: "key", privateKey, passphrase: creds.passphrase },
                pinnedHostKey
            };
        }
    }
}

/** Every base64 host key pinned for a host (or its `[host]:port` form). A host
 *  commonly has several and the client negotiates one, so all of them travel. */
function pinnedKeysFor(knownHosts: string, host: string, port: number): string[] {
    const aliases = new Set([host, `[${host}]:${port}`]);
    const keys: string[] = [];
    for (const line of knownHosts.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const [hostField, , keyField] = trimmed.split(/\s+/);
        if (hostField && keyField && hostField.split(",").some((entry) => aliases.has(entry))) {
            keys.push(keyField);
        }
    }
    return keys;
}
