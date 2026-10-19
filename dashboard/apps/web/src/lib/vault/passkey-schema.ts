/**
 * What a browser may send when it enrolls a passkey to unlock the vault.
 *
 * Strict on purpose: the object has exactly the fields the server stores plus
 * the master password hash that proves who is asking. A PRF output, a derived
 * key or an unwrapped vault key has no field to travel in, and a body that
 * carries one anyway is refused rather than quietly dropped.
 */

import { z } from "zod";

/** Passkeys one vault may have. Enough for every device somebody owns. */
export const VAULT_PASSKEYS_MAX = 10;

/** Longest name a passkey may be given. */
export const VAULT_PASSKEY_NAME_MAX = 64;

/** Standard base64 of exactly 32 bytes. */
const SALT = /^[A-Za-z0-9+/]{43}=$/;
/** Base64url, the way WebAuthn hands a credential id over. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1366}$/;
/** A type-2 enc string: iv | ciphertext | mac. */
const ENC_STRING = /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/;
/** A host name, which is all a relying party id can be. */
const RP_ID = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Trim and collapse a passkey's name, before it is checked, on both sides. */
export function normalizePasskeyName(value: unknown): unknown {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

export const vaultPasskeyEnrollSchema = z
    .object({
        masterPasswordHash: z.string().min(1).max(512),
        credentialId: z.string().regex(CREDENTIAL_ID),
        rpId: z.preprocess(
            (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
            z.string().regex(RP_ID)
        ),
        prfSalt: z.string().regex(SALT),
        wrappedKey: z.string().max(1024).regex(ENC_STRING),
        name: z.preprocess(normalizePasskeyName, z.string().min(1).max(VAULT_PASSKEY_NAME_MAX))
    })
    .strict();

export type VaultPasskeyEnrollInput = z.infer<typeof vaultPasskeyEnrollSchema>;

export const vaultPasskeyIdSchema = z.string().uuid();

/** One enrolled passkey, as the lock screen and the settings list read it. */
export interface VaultPasskeyEntry {
    id: string;
    name: string;
    credentialId: string;
    rpId: string;
    prfSalt: string;
    wrappedKey: string;
    createdAt: string;
    lastUsedAt: string | null;
}
