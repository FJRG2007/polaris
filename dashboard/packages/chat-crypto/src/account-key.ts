/**
 * The account key (`AK`, design 3.1).
 *
 * `AK` is 32 random bytes and nothing else: the signing pair (Ed25519) and the
 * hybrid HPKE pair (X25519 + ML-KEM-768, as X-Wing) are both derived from it
 * with HKDF under distinct labels. Keeping the secret that small is what lets
 * every lock wrap the same 48-byte envelope, and it means a lock never has to
 * carry - or a reviewer never has to check the serialisation of - two private
 * keys of different shapes.
 *
 * `AK` exists in clear only in this tab's memory. The server receives the two
 * public keys (so others can seal to the account) and envelopes, never `AK`.
 */

import { XWing } from "@hpke/hybridkem-x-wing";
import { canonical, owned, randomBytes } from "./bytes";

export const ACCOUNT_KEY_BYTES = 32;

const SIGN_LABEL = "polaris/chat-e2ee/ak/v1/sign-ed25519";
const HPKE_LABEL = "polaris/chat-e2ee/ak/v1/hpke-xwing";

/** RFC 8410 PKCS#8 prefix for an Ed25519 private key given as its 32-byte seed. */
const ED25519_PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

export function generateAccountKey(): Uint8Array {
    return randomBytes(ACCOUNT_KEY_BYTES);
}

async function derive(accountKey: Uint8Array, label: string): Promise<Uint8Array> {
    if (accountKey.length !== ACCOUNT_KEY_BYTES) throw new RangeError("An account key is 32 bytes");
    const base = await crypto.subtle.importKey("raw", owned(accountKey), "HKDF", false, [
        "deriveBits"
    ]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: owned(canonical(label)) },
        base,
        256
    );
    return new Uint8Array(bits);
}

/** The account's signing pair. The private half is non-extractable. */
export async function accountSigningKeyPair(
    accountKey: Uint8Array
): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
    const seed = await derive(accountKey, SIGN_LABEL);
    const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
    pkcs8.set(ED25519_PKCS8_PREFIX);
    pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
    seed.fill(0);
    // Imported extractable once only to read the public half out as a JWK; the
    // key handed back is a second, non-extractable import of the same seed.
    const readable = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", readable);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
    pkcs8.fill(0);
    const x = (jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(x + "=".repeat((4 - (x.length % 4)) % 4));
    const publicKey = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { privateKey, publicKey };
}

/** The account's hybrid HPKE pair (X-Wing: X25519 + ML-KEM-768). */
export async function accountHpkeKeyPair(accountKey: Uint8Array): Promise<CryptoKeyPair> {
    const ikm = await derive(accountKey, HPKE_LABEL);
    try {
        return await new XWing().deriveKeyPair(owned(ikm));
    } finally {
        ikm.fill(0);
    }
}

/** What the server is given about an account key: its two public halves. */
export interface AccountPublicKeys {
    readonly signPublicKey: Uint8Array;
    readonly hpkePublicKey: Uint8Array;
}

export async function accountPublicKeys(accountKey: Uint8Array): Promise<AccountPublicKeys> {
    const [{ publicKey: signPublicKey }, hpke] = await Promise.all([
        accountSigningKeyPair(accountKey),
        accountHpkeKeyPair(accountKey)
    ]);
    const hpkePublicKey = new Uint8Array(await new XWing().serializePublicKey(hpke.publicKey));
    return { signPublicKey, hpkePublicKey };
}

/**
 * Whether an account's public keys are the ones the account really published.
 *
 * Anything that obtains `AK` from a channel the server relays (the QR approval)
 * or a lock the server stores must ask this before trusting the key: a server
 * that can hand out envelopes can hand out an envelope of a key it made.
 * Phase 3 answers it from the key transparency log (design 4.6); until then the
 * web client's implementation compares against the server-published key, which
 * stops everything but a server that lies consistently. Only `true` accepts.
 */
export interface AccountKeyVerifier {
    verify(userId: string, akVersion: number, keys: AccountPublicKeys): Promise<boolean>;
}

/** Equal public keys, byte for byte. Public values: no secret is compared. */
export function samePublicKeys(a: AccountPublicKeys, b: AccountPublicKeys): boolean {
    const equal = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((byte, index) => byte === y[index]);
    return equal(a.signPublicKey, b.signPublicKey) && equal(a.hpkePublicKey, b.hpkePublicKey);
}
