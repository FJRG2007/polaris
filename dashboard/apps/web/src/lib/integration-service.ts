/**
 * Integrations service. An integration is a configured third-party provider from
 * the marketplace (one row per provider). Non-secret options live in a JSON
 * `config`; an API key is envelope-encrypted with the master key, exactly like
 * storage credentials, so a DB dump never yields a usable key. The plaintext key
 * is only ever decrypted server-side when a provider is actually called - it is
 * never returned to the client (the UI shows whether a key is set, not the key).
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret, encryptSecret, CredentialDecryptError } from "@polaris/storage";

/** Known marketplace providers. Extend this as integrations are added. */
export type IntegrationProvider = "virustotal";

/** Public (non-secret) state of an integration, safe to send to the client. */
export interface IntegrationState {
    provider: string;
    enabled: boolean;
    config: Record<string, unknown>;
    /** Whether an API key/secret is stored (never the key itself). */
    hasCredential: boolean;
    updatedAt: string | null;
}

/** Parse a stored JSON config into an object (empty on any error). */
function parseConfig(json: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** The public state of one provider (defaults when it has never been configured). */
export async function getIntegrationState(provider: IntegrationProvider): Promise<IntegrationState> {
    const row = await prisma.integration.findUnique({ where: { provider } });
    if (!row) {
        return { provider, enabled: false, config: {}, hasCredential: false, updatedAt: null };
    }
    return {
        provider,
        enabled: row.enabled,
        config: parseConfig(row.config),
        hasCredential: row.encryptedCredential !== null,
        updatedAt: row.updatedAt.toISOString()
    };
}

/**
 * Create or update a provider's configuration. A `credential` string is encrypted
 * and stored; passing `null` clears it; passing `undefined` leaves it unchanged
 * (so toggling `enabled` never forces re-entering the key).
 */
export async function saveIntegration(input: {
    provider: IntegrationProvider;
    enabled: boolean;
    config: Record<string, unknown>;
    credential?: string | null;
}): Promise<void> {
    const configJson = JSON.stringify(input.config ?? {});
    // undefined -> leave the stored key untouched; null -> clear it; a string ->
    // (re)seal it. Compute the sealed blob once and reuse it for create and update.
    const sealed = input.credential ? sealCredential(input.credential) : null;
    const credentialFields =
        input.credential === undefined
            ? {}
            : input.credential === null
              ? { encryptedCredential: null, credentialNonce: null, credentialKeyId: null }
              : sealed!;

    await prisma.integration.upsert({
        where: { provider: input.provider },
        create: {
            provider: input.provider,
            enabled: input.enabled,
            config: configJson,
            ...(sealed ?? {})
        },
        update: { enabled: input.enabled, config: configJson, ...credentialFields }
    });
}

/** Encrypt a secret into the Integration credential columns. */
function sealCredential(secret: string): {
    encryptedCredential: Buffer;
    credentialNonce: Buffer;
    credentialKeyId: string;
} {
    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    return {
        encryptedCredential: blob.ciphertext,
        credentialNonce: blob.nonce,
        credentialKeyId: blob.keyId
    };
}

/**
 * Load a provider's decrypted API key, but only when it is enabled and configured.
 * Returns null when the provider is off, has no key, or the key cannot be
 * decrypted (a changed master key) - callers treat all three as "not available".
 */
export async function getEnabledCredential(
    provider: IntegrationProvider
): Promise<{ config: Record<string, unknown>; credential: string } | null> {
    const row = await prisma.integration.findUnique({ where: { provider } });
    if (!row || !row.enabled || !row.encryptedCredential || !row.credentialNonce) return null;
    try {
        const credential = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedCredential),
                nonce: Buffer.from(row.credentialNonce),
                keyId: row.credentialKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        return { config: parseConfig(row.config), credential };
    } catch (error) {
        if (error instanceof CredentialDecryptError) return null;
        throw error;
    }
}
