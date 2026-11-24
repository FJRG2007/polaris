/**
 * The signature on the add-on catalog. CI signs the catalog's exact bytes with
 * an Ed25519 key kept as a repository secret (.github/workflows/device-addons.yml);
 * the app holds the public halves. Several keys may be trusted at once, so a key
 * is replaced by shipping its successor in a release before the catalog moves to
 * it. Pure, for the tests.
 */

import { z } from "zod";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ADDON_CATALOG_KEYS } from "@polaris/core/device-addons";

export interface TrustedKey {
    readonly id: string;
    /** The raw 32-byte public key, hex. */
    readonly publicKey: string;
}

export const TRUSTED_KEYS: readonly TrustedKey[] = ADDON_CATALOG_KEYS;

/** `catalog.json.sig`: which key signed it and the signature, base64. */
export const signatureFileSchema = z.object({
    keyId: z.string().min(1).max(64),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
});

function hex(text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** Whether `bytes` carry a valid signature by one of the trusted keys. Never throws. */
export function verifySigned(bytes: Uint8Array, signatureFile: unknown, keys: readonly TrustedKey[] = TRUSTED_KEYS): boolean {
    const parsed = signatureFileSchema.safeParse(signatureFile);
    if (!parsed.success) return false;
    const key = keys.find((candidate) => candidate.id === parsed.data.keyId);
    if (!key) return false;
    try {
        return ed25519.verify(Uint8Array.from(Buffer.from(parsed.data.signature, "base64")), bytes, hex(key.publicKey));
    } catch {
        return false;
    }
}
