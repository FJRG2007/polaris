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
    SmbDriver,
    type ConnectionRecord,
    type StorageDriver
} from "@polaris/storage";
import { fetchUnasMetrics, type UnasMetrics } from "@/lib/unifi-unas";

/** Base path under which the host daemon mounts SMB/NFS shares. */
const HOSTD_MOUNT_ROOT = "/mnt/polaris";

/**
 * Raised when a UniFi UNAS connection is asked to browse files but has no SMB
 * share configured yet. The Drive UI catches this to prompt for the share name
 * (credentials are reused) rather than showing a generic failure.
 */
export class SmbShareRequiredError extends Error {
    public constructor() {
        super("SMB_SHARE_REQUIRED");
        this.name = "SmbShareRequiredError";
    }
}

/** Load a connection scoped to its owner, or throw. */
async function loadConnection(connectionId: string, ownerId: string) {
    const row = await prisma.storageConnection.findFirst({ where: { id: connectionId, ownerId } });
    if (!row) throw new Error("Connection not found");
    return row;
}

/** The minimal storage-connection row this module needs to build a driver. */
type ConnectionRow = {
    id: string;
    kind: string;
    config: string;
    encryptedCredential: Uint8Array | null;
    credentialNonce: Uint8Array | null;
    credentialKeyId: string | null;
};

/** Decrypt a row's credentials and build a connected driver for it. */
async function buildDriver(row: ConnectionRow): Promise<StorageDriver> {
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

    // A UniFi UNAS is a metrics connection, but its files are reachable over the
    // SMB share on the same device - and the UNAS accepts the same UniFi account,
    // so we reuse the stored username/password and only need the share name. When
    // the share is set, browse over SMB; otherwise signal the UI to ask for it.
    if (row.kind === "unifi-unas") {
        const cfg = config as Extract<StorageConfig, { kind: "unifi-unas" }>;
        if (!cfg.smbShare) throw new SmbShareRequiredError();
        const creds = credentials as Extract<StorageCredentials, { kind: "unifi-unas" }>;
        const driver = new SmbDriver({
            id: row.id,
            host: cfg.host,
            port: 445,
            share: cfg.smbShare,
            username: cfg.username,
            password: creds.password
        });
        await driver.connect();
        return driver;
    }

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

/** Build a connected driver for a connection owned by the given user. */
export async function getDriver(connectionId: string, ownerId: string): Promise<StorageDriver> {
    return buildDriver(await loadConnection(connectionId, ownerId));
}

/**
 * Build a driver for a connection WITHOUT an owner check. Only for server-trusted
 * public paths (share/file-request access) where a validated token row is the
 * authorization; never call this from a user-facing action, which must scope to
 * the caller with getDriver().
 */
export async function getDriverForConnection(connectionId: string): Promise<StorageDriver> {
    const row = await prisma.storageConnection.findUnique({ where: { id: connectionId } });
    if (!row) throw new Error("Connection not found");
    return buildDriver(row);
}

/** Native UniFi UNAS metrics for a connection (via the UniFi OS console API). */
export async function getUnasMetrics(connectionId: string, ownerId: string): Promise<UnasMetrics> {
    const row = await loadConnection(connectionId, ownerId);
    if (row.kind !== "unifi-unas") throw new Error("Not a UniFi UNAS connection");
    const env = loadEnv();
    const config = JSON.parse(row.config) as Extract<StorageConfig, { kind: "unifi-unas" }>;
    const credentials =
        row.encryptedCredential && row.credentialNonce
            ? decryptCredentials<{ password?: string }>(
                  {
                      ciphertext: Buffer.from(row.encryptedCredential),
                      nonce: Buffer.from(row.credentialNonce),
                      keyId: row.credentialKeyId ?? ""
                  },
                  env.POLARIS_MASTER_KEY
              )
            : {};
    return fetchUnasMetrics({
        host: config.host,
        port: config.port,
        username: config.username,
        password: credentials.password ?? "",
        secure: config.secure
    });
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

/** Set the SMB share used to browse a UniFi UNAS connection's files. */
export async function setUnasSmbShare(ownerId: string, connectionId: string, share: string): Promise<void> {
    const row = await loadConnection(connectionId, ownerId);
    if (row.kind !== "unifi-unas") throw new Error("Not a UniFi UNAS connection");
    const config = JSON.parse(row.config) as Record<string, unknown>;
    config.smbShare = share.trim();
    await prisma.storageConnection.update({
        where: { id: connectionId },
        data: { config: JSON.stringify(config) }
    });
}
