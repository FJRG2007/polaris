/**
 * Integration service. One row per marketplace provider (instance-wide), holding
 * an enabled flag, a non-secret JSON config, and an envelope-encrypted secret
 * (an API key) at rest - the same AES-256-GCM master key that protects storage
 * credentials, so a database dump yields no usable keys. The catalog of what CAN
 * be installed lives in the registry (code); this module owns what IS installed.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { encryptSecret, decryptSecret, CredentialDecryptError } from "@polaris/storage";

/** Public (secret-free) view of an installed integration, for the UI. */
export interface IntegrationState {
    provider: string;
    enabled: boolean;
    config: Record<string, unknown>;
    hasSecret: boolean;
    updatedAt: string | null;
}

/** Parse a stored config JSON string into a plain object (empty on any error). */
function parseConfig(json: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

type IntegrationRow = {
    provider: string;
    enabled: boolean;
    config: string;
    encryptedSecret: Uint8Array | null;
    updatedAt: Date;
};

function toState(row: IntegrationRow): IntegrationState {
    return {
        provider: row.provider,
        enabled: row.enabled,
        config: parseConfig(row.config),
        hasSecret: row.encryptedSecret !== null,
        updatedAt: row.updatedAt.toISOString()
    };
}

/** The installed state of every integration, keyed by provider slug. */
export async function listIntegrationStates(): Promise<Map<string, IntegrationState>> {
    const rows = await prisma.integration.findMany();
    return new Map(rows.map((row) => [row.provider, toState(row)]));
}

/** The installed state of one integration, or null if never configured. */
export async function getIntegrationState(provider: string): Promise<IntegrationState | null> {
    const row = await prisma.integration.findUnique({ where: { provider } });
    return row ? toState(row) : null;
}

/**
 * Create or update an integration. `secret` is tri-state: undefined keeps the
 * stored key, a non-empty string replaces it, and null (or "") clears it. The
 * config object fully replaces the stored config when provided.
 */
export async function upsertIntegration(
    provider: string,
    input: {
        enabled?: boolean;
        config?: Record<string, unknown>;
        secret?: string | null;
        installedById?: string;
    }
): Promise<void> {
    const env = loadEnv();
    const configJson = input.config !== undefined ? JSON.stringify(input.config) : undefined;

    let secretFields: {
        encryptedSecret: Buffer | null;
        secretNonce: Buffer | null;
        secretKeyId: string | null;
    } | null = null;
    if (input.secret !== undefined) {
        if (input.secret && input.secret.trim()) {
            const blob = encryptSecret(input.secret.trim(), env.POLARIS_MASTER_KEY);
            secretFields = { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
        } else {
            secretFields = { encryptedSecret: null, secretNonce: null, secretKeyId: null };
        }
    }

    await prisma.integration.upsert({
        where: { provider },
        create: {
            provider,
            enabled: input.enabled ?? false,
            config: configJson ?? "{}",
            installedById: input.installedById ?? null,
            ...(secretFields ?? {})
        },
        update: {
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(configJson !== undefined ? { config: configJson } : {}),
            ...(secretFields ?? {})
        }
    });
}

/** Remove an integration entirely (disables and forgets its key). */
export async function deleteIntegration(provider: string): Promise<void> {
    await prisma.integration.deleteMany({ where: { provider } });
}

/** Decrypt and return an integration's stored secret, or null if none/undecryptable. */
export async function getIntegrationSecret(provider: string): Promise<string | null> {
    const row = await prisma.integration.findUnique({
        where: { provider },
        select: { encryptedSecret: true, secretNonce: true, secretKeyId: true }
    });
    if (!row?.encryptedSecret || !row.secretNonce) return null;
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedSecret),
                nonce: Buffer.from(row.secretNonce),
                keyId: row.secretKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}
