/**
 * Server-side Docker service. Turns a stored Docker connection into a live driver
 * (decrypting any secret transport material with the shared credential crypto),
 * and persists connections. The common local case - the socket or the
 * install-provisioned SSH key - carries no stored secret at all.
 */

import { loadEnv } from "@polaris/config";
import type { DockerConfig, DockerCredentials } from "@polaris/docker";
import { createDockerDriver, type DockerConnectionRecord } from "@polaris/docker";
import { prisma } from "@polaris/db";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";

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
