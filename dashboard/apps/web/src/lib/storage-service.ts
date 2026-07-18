/**
 * Server-side storage service. Turns a stored connection row into a live driver:
 * loads it (scoped to its owner), decrypts credentials with the master key, and
 * asks the registry to build the right driver for the current edition. Providers
 * that need a kernel mount are handled by pointing a local driver at the path
 * where polaris-hostd mounts them; establishing that mount is a separate
 * activation step (see enigma marker).
 */

import { getCapabilities, loadEnv } from "@polaris/config";
import type { StorageConfig, StorageCredentials, StorageProviderKind } from "@polaris/core";
import { requiresHostd } from "@polaris/core";
import { prisma } from "@polaris/db";
import {
    createDriver,
    decryptCredentials,
    encryptCredentials,
    LocalDriver,
    type ConnectionRecord,
    type StorageDriver
} from "@polaris/storage";

/** Base path under which the host daemon mounts SMB/NFS shares. */
const HOSTD_MOUNT_ROOT = "/mnt/polaris";

/** Load a connection scoped to its owner, or throw. */
async function loadConnection(connectionId: string, ownerId: string) {
    const row = await prisma.storageConnection.findFirst({ where: { id: connectionId, ownerId } });
    if (!row) throw new Error("Connection not found");
    return row;
}

/** Build a connected driver for a connection owned by the given user. */
export async function getDriver(connectionId: string, ownerId: string): Promise<StorageDriver> {
    const row = await loadConnection(connectionId, ownerId);
    const env = loadEnv();
    const config = JSON.parse(row.config) as StorageConfig;
    const credentials: StorageCredentials =
        row.encryptedCredential && row.credentialNonce
            ? decryptCredentials(
                  {
                      ciphertext: Buffer.from(row.encryptedCredential),
                      nonce: Buffer.from(row.credentialNonce),
                      keyId: row.credentialKeyId ?? ""
                  },
                  env.POLARIS_MASTER_KEY
              )
            : ({ kind: row.kind } as StorageCredentials);

    const record: ConnectionRecord = {
        id: row.id,
        kind: row.kind as StorageProviderKind,
        config,
        credentials
    };

    const driver = createDriver(record, {
        capabilities: getCapabilities(),
        // enigma: the mount must already be established by an activation step that
        // calls HostdClient.createMount; wiring that lifecycle is a pending item.
        hostdFactory: (rec) => new LocalDriver({ id: rec.id, root: `${HOSTD_MOUNT_ROOT}/${rec.id}` })
    });
    await driver.connect();
    return driver;
}

/** All connections owned by a user, without secret material. */
export async function listConnections(ownerId: string) {
    return prisma.storageConnection.findMany({
        where: { ownerId },
        select: { id: true, name: true, kind: true, status: true, requiresHostd: true, createdAt: true },
        orderBy: { createdAt: "asc" }
    });
}

/** Persist a new connection, encrypting its credentials at rest. */
export async function createConnection(
    ownerId: string,
    name: string,
    kind: StorageProviderKind,
    config: StorageConfig,
    credentials: StorageCredentials
) {
    const env = loadEnv();
    const hasSecret = Object.keys(credentials).some((key) => key !== "kind");
    const blob = hasSecret ? encryptCredentials(credentials, env.POLARIS_MASTER_KEY) : null;
    return prisma.storageConnection.create({
        data: {
            ownerId,
            name,
            kind,
            config: JSON.stringify(config),
            requiresHostd: requiresHostd(kind),
            encryptedCredential: blob?.ciphertext ?? null,
            credentialNonce: blob?.nonce ?? null,
            credentialKeyId: blob?.keyId ?? null
        },
        select: { id: true }
    });
}

/** Delete a connection owned by the user. */
export async function deleteConnection(ownerId: string, connectionId: string) {
    await prisma.storageConnection.deleteMany({ where: { id: connectionId, ownerId } });
}
