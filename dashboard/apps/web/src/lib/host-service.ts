/**
 * Server-side Host service. A Host is a global SSH server registered once and
 * consumed by multiple apps (Docker over SSH in Containers, SFTP in Drive). This
 * turns a stored Host into connection parameters for the shared SSH primitive,
 * and adds/removes Hosts - trust-on-add captures and pins the server key so later
 * connections verify it, and credentials are envelope-encrypted at rest with the
 * same crypto the storage/docker connections use.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { dropSshConnections } from "@/lib/connection-pool";
import { testAndCaptureHostKey, type SshAuth } from "@polaris/ssh";
import { isBaseDomain, normalizeBaseDomain } from "@polaris/deploy";
import { decryptSecret, encryptCredentials, type EncryptedBlob } from "@polaris/storage";
import { hostCredentialsSchema, type CreateHostInput, type HostCredentials, type ServerEnvironment } from "@polaris/core";

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
            sudo: true,
            os: true,
            environment: true,
            wildcardDomain: true,
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
    return connectionFor(await prisma.host.findFirst({ where: { id: hostId, ownerId } }));
}

/**
 * The same, without the owner check. Only for callers that have already
 * authorized the server some other way - Drive's `authorizeDrive` choke point,
 * which resolves a `host:` source before it ever asks for a driver. Never call
 * this from something a user reaches directly.
 */
export async function getHostConnectionUnscoped(hostId: string): Promise<HostConnection> {
    return connectionFor(await prisma.host.findUnique({ where: { id: hostId } }));
}

type HostRow = Awaited<ReturnType<typeof prisma.host.findUnique>>;

function connectionFor(row: HostRow): HostConnection {
    if (!row) throw new Error("Host not found");
    if (!row.encryptedCredential || !row.credentialNonce) {
        throw new Error("Host has no stored credentials");
    }
    const creds = readCredentials(
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
            environment: input.config.environment,
            hostKey,
            encryptedCredential: blob.ciphertext,
            credentialNonce: blob.nonce,
            credentialKeyId: blob.keyId
        },
        select: { id: true }
    });
}

/** Rename a host. Owner-scoped: false when no host of this owner matched, so a
 *  caller never reports a change that did not happen. */
export async function renameHost(ownerId: string, hostId: string, name: string): Promise<boolean> {
    const { count } = await prisma.host.updateMany({ where: { id: hostId, ownerId }, data: { name } });
    return count > 0;
}

/** Record where a host lives, which decides how a domain can be pointed at it.
 *  Owner-scoped: false when no host of this owner matched, so a caller never
 *  reports a change that did not happen. */
export async function setHostEnvironment(
    ownerId: string,
    hostId: string,
    environment: ServerEnvironment
): Promise<boolean> {
    const { count } = await prisma.host.updateMany({ where: { id: hostId, ownerId }, data: { environment } });
    return count > 0;
}

/**
 * Point a wildcard domain at a server, so its services get real domains from its
 * own edge rather than a hostname that encodes its IP. Blank clears it. The value
 * is normalized the same way as the Polaris zone base, so a pasted `*.apps.example.com`
 * or `https://apps.example.com/` all store as `apps.example.com` - a stray scheme or
 * wildcard prefix would otherwise end up inside every hostname built from it.
 * Owner-scoped; false when no host of this owner matched.
 */
export async function setHostWildcardDomain(ownerId: string, hostId: string, domain: string): Promise<boolean> {
    const clean = normalizeBaseDomain(domain);
    if (clean && !isBaseDomain(clean)) throw new Error("Enter a domain like apps.example.com");
    const { count } = await prisma.host.updateMany({
        where: { id: hostId, ownerId },
        data: { wildcardDomain: clean || null }
    });
    return count > 0;
}

export async function deleteHost(ownerId: string, hostId: string): Promise<void> {
    await prisma.host.deleteMany({ where: { id: hostId, ownerId } });
    // Connections are pooled and outlive a single request, so a machine that is no
    // longer Polaris's must have its open sessions closed here rather than waiting
    // for an idle sweep to notice.
    dropSshConnections(hostId);
}

/**
 * Decrypt a host credential into its parsed form.
 *
 * A credential is stored as a JSON `HostCredentials`, but enrollment used to store
 * the bare private key instead, which left every server added by the enrollment
 * command unusable: the parse threw on the PEM's leading dash, Drive surfaced that
 * as an error and the terminal swallowed it into "invalid ticket". Those rows are
 * still out there, so plaintext that is not a credential object is read as the key
 * it actually is rather than failing.
 */
export function readCredentials(blob: EncryptedBlob, masterKey: string): HostCredentials {
    const secret = decryptSecret(blob, masterKey);
    let parsed: unknown;
    try {
        parsed = JSON.parse(secret);
    } catch {
        return { method: "key", privateKey: secret };
    }
    const credentials = hostCredentialsSchema.safeParse(parsed);
    return credentials.success ? credentials.data : { method: "key", privateKey: secret };
}

function toSshAuth(creds: HostCredentials): SshAuth {
    return creds.method === "password"
        ? { method: "password", password: creds.password }
        : { method: "key", privateKey: creds.privateKey, passphrase: creds.passphrase };
}
