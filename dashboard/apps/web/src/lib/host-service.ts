/**
 * Server-side Host service. A Host is a global SSH server registered once and
 * consumed by multiple apps (Docker over SSH in Containers, SFTP in Drive). This
 * turns a stored Host into connection parameters for the shared SSH primitive,
 * and adds/removes Hosts - trust-on-add captures and pins the server key so later
 * connections verify it, and credentials are envelope-encrypted at rest with the
 * same crypto the storage/docker connections use.
 */

import { loadEnv } from "@polaris/config";
import type { CreateHostInput, HostCredentials } from "@polaris/core";
import { prisma } from "@polaris/db";
import { testAndCaptureHostKey, type SshAuth } from "@polaris/ssh";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";

/** Non-secret fields safe to show in listings. */
export async function listHosts(ownerId: string) {
    return prisma.host.findMany({
        where: { ownerId },
        select: {
            id: true,
            name: true,
            address: true,
            port: true,
            username: true,
            authMethod: true,
            status: true,
            createdAt: true
        },
        orderBy: { createdAt: "asc" }
    });
}

export interface HostConnection {
    readonly id: string;
    readonly name: string;
    readonly address: string;
    readonly port: number;
    readonly username: string;
    readonly auth: SshAuth;
    readonly hostKey?: string;
}

/** Decrypt a host's credentials into connection parameters for a connector. */
export async function getHostConnection(hostId: string, ownerId: string): Promise<HostConnection> {
    const row = await prisma.host.findFirst({ where: { id: hostId, ownerId } });
    if (!row) throw new Error("Host not found");
    if (!row.encryptedCredential || !row.credentialNonce) {
        throw new Error("Host has no stored credentials");
    }
    const creds = decryptCredentials<HostCredentials>(
        {
            ciphertext: Buffer.from(row.encryptedCredential),
            nonce: Buffer.from(row.credentialNonce),
            keyId: row.credentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return {
        id: row.id,
        name: row.name,
        address: row.address,
        port: row.port,
        username: row.username,
        auth: toSshAuth(creds),
        hostKey: row.hostKey ?? undefined
    };
}

/**
 * Register a host. Validates the credentials by connecting once and captures the
 * server key to pin (trust-on-add); only then is the host stored. Returns the new
 * id, or throws with a client-safe message if the connection or auth fails.
 */
export async function createHost(ownerId: string, input: CreateHostInput): Promise<{ id: string }> {
    const auth = toSshAuth(input.credentials);
    const hostKey = await testAndCaptureHostKey({
        host: input.config.address,
        port: input.config.port,
        username: input.config.username,
        auth
    });
    const blob = encryptCredentials(input.credentials, loadEnv().POLARIS_MASTER_KEY);
    return prisma.host.create({
        data: {
            ownerId,
            name: input.name,
            address: input.config.address,
            port: input.config.port,
            username: input.config.username,
            authMethod: input.config.authMethod,
            hostKey,
            encryptedCredential: blob.ciphertext,
            credentialNonce: blob.nonce,
            credentialKeyId: blob.keyId
        },
        select: { id: true }
    });
}

export async function deleteHost(ownerId: string, hostId: string): Promise<void> {
    await prisma.host.deleteMany({ where: { id: hostId, ownerId } });
}

function toSshAuth(creds: HostCredentials): SshAuth {
    return creds.method === "password"
        ? { method: "password", password: creds.password }
        : { method: "key", privateKey: creds.privateKey, passphrase: creds.passphrase };
}
