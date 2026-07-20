/**
 * Envelope encryption for stored storage credentials. Passwords, private keys,
 * and API tokens for NAS connections are secrets at rest: we encrypt them with
 * AES-256-GCM under a master key supplied via POLARIS_MASTER_KEY and store only
 * the ciphertext, the nonce, and a short key fingerprint.
 *
 * The fingerprint (keyId) records WHICH master key encrypted a row without
 * revealing the key, so an operator can rotate the master key - new rows use the
 * new key while old rows still decrypt under their recorded one until re-saved.
 * GCM's auth tag is appended to the ciphertext, giving tamper detection for
 * free; a modified blob fails to decrypt rather than yielding garbage.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Raised when stored credentials cannot be decrypted - almost always because the
 * POLARIS_MASTER_KEY that encrypted them differs from the current one (it was
 * regenerated). The raw Node error ("Unsupported state or unable to authenticate
 * data") is opaque; call sites catch this to tell the user to re-add the
 * connection instead.
 */
export class CredentialDecryptError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "CredentialDecryptError";
    }
}

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedBlob {
    /** ciphertext with the 16-byte GCM auth tag appended. */
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    /** Short fingerprint of the master key used, for rotation. */
    readonly keyId: string;
}

/** Decode and validate the base64 master key into 32 raw bytes. */
function loadMasterKey(masterKeyB64: string): Buffer {
    const key = Buffer.from(masterKeyB64, "base64");
    if (key.length !== KEY_BYTES) {
        throw new Error(
            `POLARIS_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`
        );
    }
    return key;
}

/** First 8 hex chars of SHA-256(key): identifies the key without exposing it. */
export function keyFingerprint(masterKeyB64: string): string {
    const key = loadMasterKey(masterKeyB64);
    return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Encrypt a UTF-8 plaintext (typically a JSON credential blob). */
export function encryptSecret(plaintext: string, masterKeyB64: string): EncryptedBlob {
    const key = loadMasterKey(masterKeyB64);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        ciphertext: Buffer.concat([body, tag]),
        nonce,
        keyId: keyFingerprint(masterKeyB64)
    };
}

/** Decrypt a blob produced by encryptSecret. Throws if tampered or wrong key. */
export function decryptSecret(blob: EncryptedBlob, masterKeyB64: string): string {
    const key = loadMasterKey(masterKeyB64);
    if (blob.ciphertext.length < TAG_BYTES) {
        throw new Error("Ciphertext too short to contain an auth tag");
    }
    // If the row records a different key fingerprint than the current key, it was
    // encrypted with a master key that has since changed; say so precisely.
    if (blob.keyId && blob.keyId !== keyFingerprint(masterKeyB64)) {
        throw new CredentialDecryptError(
            "This connection's saved credentials were encrypted with a different master key. Update its credentials to restore access."
        );
    }
    const body = blob.ciphertext.subarray(0, blob.ciphertext.length - TAG_BYTES);
    const tag = blob.ciphertext.subarray(blob.ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, blob.nonce);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
        throw new CredentialDecryptError(
            "This connection's saved credentials could not be decrypted (the master key may have changed). Update its credentials to restore access."
        );
    }
}

/** Convenience: encrypt a credentials object as JSON. */
export function encryptCredentials(credentials: unknown, masterKeyB64: string): EncryptedBlob {
    return encryptSecret(JSON.stringify(credentials), masterKeyB64);
}

/** Convenience: decrypt back into a parsed credentials object. */
export function decryptCredentials<T>(blob: EncryptedBlob, masterKeyB64: string): T {
    return JSON.parse(decryptSecret(blob, masterKeyB64)) as T;
}
