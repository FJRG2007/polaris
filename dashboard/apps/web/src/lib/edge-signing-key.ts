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
 * Read once per process and cached; created on first use. Created only where nothing
 * is stored yet (or replaced only if what is stored is still the unreadable value this
 * process saw), then read back: two processes racing the first creation both end up
 * signing with whichever pair was stored, never with one whose public half was
 * overwritten.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { getSetting } from "@/lib/setting-store";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    type KeyObject
} from "node:crypto";

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

function readKey(raw: string | null): EdgeSigningKey | null {
    const stored = unseal(raw);
    if (!stored) return null;
    try {
        const privateKey = createPrivateKey(stored);
        return { privateKey, publicKey: publicKeyOf(privateKey) };
    } catch {
        return null;
    }
}

async function loadOrCreate(): Promise<EdgeSigningKey> {
    const raw = await getSetting(KEY_SETTING);
    const existing = readKey(raw);
    if (existing) return existing;
    // Missing, or unreadable (a master key that changed): make a new pair. Tokens signed
    // by an old one stop verifying and their holders sign in again.
    const { privateKey } = generateKeyPairSync("ed25519");
    const value = seal(privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    if (raw === null) {
        await prisma.setting.createMany({
            data: [{ key: KEY_SETTING, value, scope: "global" }],
            skipDuplicates: true
        });
    } else {
        await prisma.setting.updateMany({
            where: { key: KEY_SETTING, value: raw },
            data: { value }
        });
    }
    const settled = readKey(await getSetting(KEY_SETTING));
    if (!settled) throw new Error("The edge signing key could not be stored");
    return settled;
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
        console.error(
            "polaris: the edge signing key could not be read:",
            error instanceof Error ? error.message : error
        );
        return [];
    }
}
