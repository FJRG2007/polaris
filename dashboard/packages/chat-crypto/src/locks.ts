/**
 * One envelope format for every lock on the account key (design 3.2).
 *
 * A lock is anything that can produce a 256-bit secret the server never sees:
 * the device's non-extractable key, OPAQUE's export key, a passkey's PRF output.
 * Each one is held as a non-extractable HKDF `CryptoKey` and turned into a
 * fresh AES-256-GCM key and nonce per envelope:
 *
 *     header = version || kind || salt(32)
 *     aad    = header || canonical(label, userId, kind, lockId, akVersion)
 *     key || nonce = HKDF-SHA256(lockKey, salt, info = "…/wrap" || aad)
 *     envelope = header || AES-256-GCM(key, nonce, AK, aad)
 *
 * Why it is shaped like that:
 * - The nonce is derived, never a bare random 96-bit value (11.1 item 1): every
 *   envelope draws a fresh 256-bit salt, so key and nonce are both new each
 *   time and a repeat needs a salt collision, not a nonce collision.
 * - Everything the envelope is FOR is in the AAD (11.1 item 2): the account,
 *   the lock kind, the lock's own id and the key version. An envelope moved to
 *   another account, another lock or another version fails authentication
 *   instead of opening to the wrong key.
 * - The label carries a version and is distinct from every other derivation in
 *   the package (11.1 item 4); the version byte is a closed list (item 13).
 */

import { ACCOUNT_KEY_BYTES } from "./account-key";
import { canonical, concat, owned, randomBytes } from "./bytes";

export const LOCK_ENVELOPE_VERSION = 1;

/** Closed list. Anything else in an envelope is refused, never guessed at. */
export const LOCK_KINDS = { device: 1, password: 2, "passkey-prf": 3 } as const;
export type LockKind = keyof typeof LOCK_KINDS;

const SALT_BYTES = 32;
const TAG_BYTES = 16;
const HEADER_BYTES = 2 + SALT_BYTES;
export const LOCK_ENVELOPE_BYTES = HEADER_BYTES + ACCOUNT_KEY_BYTES + TAG_BYTES;

const LABEL = "polaris/chat-e2ee/ak-lock/v1";

/** What an envelope is bound to. All of it goes into the AAD. */
export interface LockBinding {
    readonly userId: string;
    readonly kind: LockKind;
    /** "password", the passkey's credential id, or the device store's id. */
    readonly lockId: string;
    readonly akVersion: number;
}

/** Why an envelope did not open. Deliberately coarse: which byte was wrong is
 *  never reported, so a failure is not an oracle. */
export class LockOpenError extends Error {
    constructor() {
        super("The account key could not be opened with this lock");
        this.name = "LockOpenError";
    }
}

/** A 256-bit lock secret as the non-extractable key every envelope derives from. */
export async function importLockSecret(secret: Uint8Array): Promise<CryptoKey> {
    if (secret.length < 32) throw new RangeError("A lock secret is at least 32 bytes");
    return crypto.subtle.importKey("raw", owned(secret), "HKDF", false, ["deriveBits"]);
}

function kindByte(kind: LockKind): number {
    const value = LOCK_KINDS[kind];
    if (value === undefined) throw new LockOpenError();
    return value;
}

async function sessionKey(
    lockKey: CryptoKey,
    salt: Uint8Array,
    aad: Uint8Array
): Promise<{ key: CryptoKey; nonce: Uint8Array<ArrayBuffer> }> {
    const bits = new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: owned(salt),
                info: owned(concat(canonical(`${LABEL}/wrap`), aad))
            },
            lockKey,
            (32 + 12) * 8
        )
    );
    const key = await crypto.subtle.importKey("raw", bits.subarray(0, 32), "AES-GCM", false, [
        "encrypt",
        "decrypt"
    ]);
    const nonce = owned(bits.subarray(32));
    bits.fill(0);
    return { key, nonce };
}

function aadOf(header: Uint8Array, binding: LockBinding): Uint8Array<ArrayBuffer> {
    return owned(
        concat(
            header,
            canonical(LABEL, binding.userId, binding.kind, binding.lockId, binding.akVersion)
        )
    );
}

/** The account key, sealed under one lock for one binding. */
export async function sealAccountKey(
    accountKey: Uint8Array,
    lockKey: CryptoKey,
    binding: LockBinding,
    salt: Uint8Array = randomBytes(SALT_BYTES)
): Promise<Uint8Array> {
    if (accountKey.length !== ACCOUNT_KEY_BYTES) throw new RangeError("An account key is 32 bytes");
    if (salt.length !== SALT_BYTES) throw new RangeError("A lock salt is 32 bytes");
    const header = concat(new Uint8Array([LOCK_ENVELOPE_VERSION, kindByte(binding.kind)]), salt);
    const aad = aadOf(header, binding);
    const { key, nonce } = await sessionKey(lockKey, salt, aad);
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce, additionalData: aad },
            key,
            owned(accountKey)
        )
    );
    return concat(header, sealed);
}

/** The account key back out of an envelope, or a LockOpenError for any failure. */
export async function openAccountKey(
    envelope: Uint8Array,
    lockKey: CryptoKey,
    binding: LockBinding
): Promise<Uint8Array> {
    if (envelope.length !== LOCK_ENVELOPE_BYTES) throw new LockOpenError();
    if (envelope[0] !== LOCK_ENVELOPE_VERSION) throw new LockOpenError();
    if (envelope[1] !== kindByte(binding.kind)) throw new LockOpenError();
    const header = envelope.subarray(0, HEADER_BYTES);
    const salt = envelope.subarray(2, HEADER_BYTES);
    const aad = aadOf(header, binding);
    const { key, nonce } = await sessionKey(lockKey, salt, aad);
    try {
        const opened = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce, additionalData: aad },
            key,
            owned(envelope.subarray(HEADER_BYTES))
        );
        return new Uint8Array(opened);
    } catch {
        throw new LockOpenError();
    }
}
