/**
 * Server-side Docker service. Turns a stored Docker connection into a live driver
 * (decrypting any secret transport material with the shared credential crypto),
 * and persists connections. The common local case - the socket or the
 * install-provisioned SSH key - carries no stored secret at all.
 */

import { loadEnv } from "@polaris/config";
import type { DockerConfig, DockerCredentials, DockerRpc } from "@polaris/docker";
import { createDockerDriver, DockerDriver, type DockerConnectionRecord } from "@polaris/docker";
import { prisma } from "@polaris/db";
import { HostdClient } from "@polaris/hostd-client";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";

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
        request: (method, path) => client.dockerRequest(method, path),
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

export async function getDockerDriver(connectionId: string, ownerId: string) {
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
    const record: DockerConnectionRecord = { id: row.id, config, credentials };
    return createDockerDriver(record);
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
