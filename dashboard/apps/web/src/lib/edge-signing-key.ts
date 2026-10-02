/**
 * The key Polaris signs edge logins with.
 *
 * An Ed25519 pair, made once and kept: the private half sealed with the master key in
 * the settings table, never leaving this process; the public half published inside
 * every login-protected route's rule, which is how each edge - on this machine or any
 * other - verifies a visitor's token on its own, with nothing it holds able to mint
 * one. That is the difference from the HMAC token every guard can verify AND sign,
 * because verifying needs the same secret.
 *
 * Read once per process and cached; created on first use. Two processes racing the
 * first creation each write a pair and the second write wins - a token signed by the
 * loser fails once and the visitor signs in again, which is the whole cost.
 */

import { loadEnv } from "@polaris/config";
import { getSetting, setSetting } from "@/lib/setting-store";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

const KEY_SETTING = "edge.signing.ed25519";

export interface EdgeSigningKey {
    readonly privateKey: KeyObject;
    /** Raw 32-byte public key, base64url - the form a route's rule carries. */
    readonly publicKey: string;
}

let cached: Promise<EdgeSigningKey> | null = null;

/** Sealed with the master key, as every other stored credential is. The same envelope
 *  the managed certificates use, written here rather than imported so the deploy path
 *  does not load the ACME client to read one setting. */
function seal(value: string): string {
    const sealed = encryptSecret(value, loadEnv().POLARIS_MASTER_KEY);
    return JSON.stringify({
        c: sealed.ciphertext.toString("base64"),
        n: sealed.nonce.toString("base64"),
        k: sealed.keyId
    });
}

function unseal(stored: string | null): string | null {
    if (!stored) return null;
    try {
        const { c, n, k } = JSON.parse(stored) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

/** The raw public key of a private one, as the rule carries it. */
export function publicKeyOf(privateKey: KeyObject): string {
    const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
    if (!jwk.x) throw new Error("Not an Ed25519 key");
    return jwk.x;
}

async function loadOrCreate(): Promise<EdgeSigningKey> {
    const stored = unseal(await getSetting(KEY_SETTING));
    if (stored) {
        try {
            const privateKey = createPrivateKey(stored);
            return { privateKey, publicKey: publicKeyOf(privateKey) };
        } catch {
            // Unreadable (a master key that changed): make a new pair below. Tokens
            // signed by the old one stop verifying and their holders sign in again.
        }
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    await setSetting(KEY_SETTING, seal(privateKey.export({ format: "pem", type: "pkcs8" }).toString()));
    return { privateKey, publicKey: publicKeyOf(privateKey) };
}

/** The signing key, made on first use. */
export function edgeSigningKey(): Promise<EdgeSigningKey> {
    cached ??= loadOrCreate().catch((error: unknown) => {
        cached = null;
        throw error;
    });
    return cached;
}

/** The public keys a login-protected route trusts, current first. Empty when the key
 *  cannot be read, which leaves routes on the HMAC token they always used. */
export async function edgeLoginKeys(): Promise<string[]> {
    try {
        return [(await edgeSigningKey()).publicKey];
    } catch (error) {
        console.error("polaris: the edge signing key could not be read:", error instanceof Error ? error.message : error);
        return [];
    }
}
