/**
 * What a browser may send when it turns one of the account's passkeys on to
 * unlock the vault, and the shapes the lock screen and the settings card read.
 *
 * Strict on purpose: the object has exactly the fields the server stores. A PRF
 * output, a derived key or an unwrapped vault key has no field to travel in,
 * and a body that carries one anyway is refused rather than quietly dropped.
 * The proof of who is asking is not in the body either: it is the session's
 * step-up grant, checked on the server.
 */

import { z } from "zod";

/** Passkeys one vault may have. Enough for every device somebody owns. */
export const VAULT_PASSKEYS_MAX = 10;

/** Standard base64 of exactly 32 bytes. */
const SALT = /^[A-Za-z0-9+/]{43}=$/;
/** Base64url, the way WebAuthn hands a credential id over. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1366}$/;
/** A type-2 enc string: iv | ciphertext | mac. */
const ENC_STRING = /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/;

export const vaultPasskeyEnrollSchema = z
    .object({
        credentialId: z.string().regex(CREDENTIAL_ID),
        prfSalt: z.string().regex(SALT),
        wrappedKey: z.string().max(1024).regex(ENC_STRING)
    })
    .strict();

export type VaultPasskeyEnrollInput = z.infer<typeof vaultPasskeyEnrollSchema>;

export const vaultPasskeyIdSchema = z.string().uuid();

/** One passkey that unlocks this vault, as the lock screen reads it. */
export interface VaultPasskeyEntry {
    id: string;
    credentialId: string;
    /** The address its sign-in passkey belongs to, read from that row. */
    rpId: string;
    prfSalt: string;
    wrappedKey: string;
}

/** One of the account's sign-in passkeys, as the vault settings list it. */
export interface VaultPasskeyChoice {
    /** The `Passkey` row's id, which is what the list is keyed by. */
    passkeyId: string;
    /** What the person called it. Null on a row registered before names were asked for. */
    name: string | null;
    /** singleDevice | multiDevice, as WebAuthn reported it. */
    deviceType: string;
    /** When the sign-in passkey was added, ISO. */
    addedAt: string;
    credentialId: string;
    /** The only address it can answer on. */
    rpId: string;
    /** Set while it unlocks the vault. */
    vault: { id: string; lastUsedAt: string | null } | null;
}
