/**
 * The vault's cryptography, in the browser.
 *
 * This is the module that makes Polaris's own web vault as blind as an official
 * Bitwarden client: the master password is turned into a key here, everything is
 * encrypted here, and what leaves is already unreadable. Nothing in this file
 * has a server-side counterpart, and it must never grow one - a server that can
 * decrypt a vault is a server whose database is the vault.
 *
 * Every constant below is Bitwarden's, not a choice, because the same vault has
 * to open in their clients:
 *
 *   master key   = PBKDF2-SHA256(password, salt = lowercase email, iterations)
 *                | Argon2id(password, salt = SHA-256(lowercase email), t, m, p)
 *   password hash= PBKDF2-SHA256(master key, salt = password, 1 iteration)
 *   stretched    = HKDF-Expand-SHA256(master key, info "enc" | "mac", 32 bytes)
 *   enc string   = "2." + b64(iv) + "|" + b64(AES-256-CBC) + "|" + b64(HMAC)
 *   org sharing  = RSA-2048-OAEP-SHA1, written as "4." + b64(payload)
 *
 * The HMAC covers iv || ciphertext and is checked before anything is decrypted,
 * so a tampered value fails rather than opening into something else.
 */

import {
    ENC_AES_CBC256_HMAC_SHA256_B64,
    ENC_RSA_2048_OAEP_SHA1_B64,
    KDF_ARGON2ID,
    parseEncString,
    type KdfSettings
} from "@polaris/core";

/** The two halves of a vault key: one to encrypt with, one to authenticate with. */
export interface SymmetricKey {
    readonly enc: Uint8Array;
    readonly mac: Uint8Array;
}

/** Everything a browser needs to hold while a vault is unlocked. */
export interface UnlockedVault {
    /** The user's own key, the one every personal item is encrypted under. */
    readonly key: SymmetricKey;
    /** Organization keys, by organization id, once they have been unwrapped. */
    readonly orgKeys: ReadonlyMap<string, SymmetricKey>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes to standard base64, and back. */
export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** Join byte arrays, which several of the primitives below need. */
function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** Constant-time comparison, so a MAC check cannot be walked byte by byte. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
    return diff === 0;
}

/** PBKDF2-SHA256, through the platform's own implementation. */
async function pbkdf2(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    bytes: number
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const derived = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        bytes * 8
    );
    return new Uint8Array(derived);
}

/**
 * Argon2id, through hash-wasm.
 *
 * Loaded on demand: it carries a WebAssembly module, and a deployment where
 * nobody chose Argon2 should not pay for it on every page that touches a vault.
 */
async function argon2(
    password: Uint8Array,
    salt: Uint8Array,
    settings: KdfSettings
): Promise<Uint8Array> {
    const { argon2id } = await import("hash-wasm");
    return argon2id({
        password,
        salt,
        // The stored figure is MiB; the library counts KiB.
        memorySize: (settings.kdfMemory ?? 64) * 1024,
        iterations: settings.kdfIterations,
        parallelism: settings.kdfParallelism ?? 4,
        hashLength: 32,
        outputType: "binary"
    });
}

/**
 * The master key: 32 bytes derived from the master password and the address it
 * belongs to. It is never sent anywhere and never stored.
 */
export async function deriveMasterKey(
    password: string,
    email: string,
    settings: KdfSettings
): Promise<Uint8Array> {
    const secret = encoder.encode(password);
    const identity = encoder.encode(email.trim().toLowerCase());
    if (settings.kdf === KDF_ARGON2ID) {
        // Argon2 wants a fixed-size salt, so the address is hashed into one.
        const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
        return argon2(secret, salt, settings);
    }
    return pbkdf2(secret, identity, settings.kdfIterations, 32);
}

/**
 * What is sent to the server to prove the password.
 *
 * One more PBKDF2 round with the roles swapped - the master key as the input,
 * the password as the salt - so the value the server sees cannot be turned back
 * into either. The server stretches it again before storing it.
 */
export async function masterPasswordHash(
    masterKey: Uint8Array,
    password: string
): Promise<string> {
    return toBase64(await pbkdf2(masterKey, encoder.encode(password), 1, 32));
}

/**
 * HKDF-Expand with SHA-256, for exactly one block.
 *
 * Expand only, no extract: the master key is already 32 uniform bytes, so it IS
 * the pseudorandom key HKDF's second stage takes. Asking for 32 bytes means one
 * HMAC, which is why this is four lines rather than a loop.
 */
async function hkdfExpand(prk: Uint8Array, info: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        prk,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const block = await crypto.subtle.sign(
        "HMAC",
        key,
        concat(encoder.encode(info), new Uint8Array([1]))
    );
    return new Uint8Array(block);
}

/** The master key stretched into a key pair for encrypting and authenticating. */
export async function stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey> {
    const [enc, mac] = await Promise.all([hkdfExpand(masterKey, "enc"), hkdfExpand(masterKey, "mac")]);
    return { enc, mac };
}

/** HKDF-Expand with SHA-256 for an arbitrary length, in whole blocks. */
async function hkdfExpandLong(prk: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        prk,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const out = new Uint8Array(bytes);
    const infoBytes = encoder.encode(info);
    let previous = new Uint8Array(0);
    for (let counter = 1, at = 0; at < bytes; counter += 1) {
        previous = new Uint8Array(
            await crypto.subtle.sign("HMAC", key, concat(previous, infoBytes, new Uint8Array([counter])))
        );
        out.set(previous.subarray(0, Math.min(previous.length, bytes - at)), at);
        at += previous.length;
    }
    return out;
}

/**
 * A key derived from a short secret somebody was handed, rather than from a
 * password - which is what a Send's link key is.
 *
 * The shape is Bitwarden's `derive_shareable_key`, and every part of it matters
 * for a Send made in one of their clients to open here: the secret is HMAC'd
 * under the literal key `bitwarden-<name>`, and the 32 bytes that come out are
 * the PRK for an HKDF expansion to 64 - the first half encrypts, the second
 * authenticates.
 */
export async function deriveShareableKey(
    secret: Uint8Array,
    name: string,
    info = ""
): Promise<SymmetricKey> {
    const hmacKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(`bitwarden-${name}`),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const prk = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, secret));
    const expanded = await hkdfExpandLong(prk, info, 64);
    return { enc: expanded.subarray(0, 32), mac: expanded.subarray(32, 64) };
}

/** The key that opens a Send, from the 16 bytes in its link. */
export async function deriveSendKey(urlKey: Uint8Array): Promise<SymmetricKey> {
    return deriveShareableKey(urlKey, "send", "send");
}

/** Rounds a Send's link password is stretched by before it is sent. */
const SEND_PASSWORD_ITERATIONS = 100_000;

/**
 * What a recipient actually sends when a Send asks for a password.
 *
 * Never the password: it is stretched against the Send's own link key, which
 * means the value on the wire is useless for any other Send and useless without
 * the link. The parameters are Bitwarden's, so a password set in one of their
 * clients is one this can check, and the other way round.
 */
export async function sendPasswordHash(password: string, urlKey: Uint8Array): Promise<string> {
    return toBase64(
        await pbkdf2(encoder.encode(password), urlKey, SEND_PASSWORD_ITERATIONS, 32)
    );
}

/** A fresh 512-bit vault key: 32 bytes to encrypt with, 32 to authenticate with. */
export function generateSymmetricKey(): SymmetricKey {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    return { enc: bytes.subarray(0, 32), mac: bytes.subarray(32, 64) };
}

/** A vault key read back out of its 64 raw bytes. */
export function symmetricKeyFromBytes(bytes: Uint8Array): SymmetricKey {
    if (bytes.length !== 64) throw new Error("A vault key is 64 bytes");
    return { enc: bytes.subarray(0, 32), mac: bytes.subarray(32, 64) };
}

/** The 64 raw bytes of a vault key, for wrapping it under another one. */
export function symmetricKeyBytes(key: SymmetricKey): Uint8Array {
    return concat(key.enc, key.mac);
}

/** Encrypt bytes under a vault key, as a type-2 encrypted string. */
export async function encryptBytes(data: Uint8Array, key: SymmetricKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const aes = await crypto.subtle.importKey("raw", key.enc, { name: "AES-CBC" }, false, [
        "encrypt"
    ]);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aes, data)
    );
    const hmac = await crypto.subtle.importKey(
        "raw",
        key.mac,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, concat(iv, ciphertext)));
    return `${ENC_AES_CBC256_HMAC_SHA256_B64}.${toBase64(iv)}|${toBase64(ciphertext)}|${toBase64(mac)}`;
}

/** Encrypt text under a vault key. */
export async function encrypt(value: string, key: SymmetricKey): Promise<string> {
    return encryptBytes(encoder.encode(value), key);
}

/**
 * Decrypt a type-2 encrypted string, or null when it cannot be opened.
 *
 * Null covers every failure - malformed, wrong key, tampered - on purpose: to
 * whoever is looking at a field that will not open, the difference is not
 * actionable, and to an attacker each distinction is a hint.
 */
export async function decryptBytes(value: string, key: SymmetricKey): Promise<Uint8Array | null> {
    const parsed = parseEncString(value);
    if (!parsed || parsed.type !== ENC_AES_CBC256_HMAC_SHA256_B64 || !parsed.iv || !parsed.mac) {
        return null;
    }
    const iv = fromBase64(parsed.iv);
    const ciphertext = fromBase64(parsed.data);
    const hmac = await crypto.subtle.importKey(
        "raw",
        key.mac,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, concat(iv, ciphertext)));
    // Checked BEFORE decrypting: a padding oracle needs the decryption to happen.
    if (!equalBytes(expected, fromBase64(parsed.mac))) return null;
    try {
        const aes = await crypto.subtle.importKey("raw", key.enc, { name: "AES-CBC" }, false, [
            "decrypt"
        ]);
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aes, ciphertext));
    } catch {
        return null;
    }
}

/** Decrypt an encrypted string back to text, or null. */
export async function decrypt(value: string, key: SymmetricKey): Promise<string | null> {
    const bytes = await decryptBytes(value, key);
    return bytes === null ? null : decoder.decode(bytes);
}

/** A fresh RSA-2048 pair: the public half as base64 SPKI, the private as PKCS#8. */
export async function generateRsaKeyPair(): Promise<{
    publicKey: string;
    privateKey: Uint8Array;
}> {
    const pair = await crypto.subtle.generateKey(
        {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            // SHA-1 is not a security claim here; it is OAEP's mask function, and
            // it is what every Bitwarden client expects on the other side.
            hash: "SHA-1"
        },
        true,
        ["encrypt", "decrypt"]
    );
    const [spki, pkcs8] = await Promise.all([
        crypto.subtle.exportKey("spki", pair.publicKey),
        crypto.subtle.exportKey("pkcs8", pair.privateKey)
    ]);
    return { publicKey: toBase64(new Uint8Array(spki)), privateKey: new Uint8Array(pkcs8) };
}

/** Encrypt to somebody's public key, as a type-4 encrypted string. */
export async function encryptRsa(data: Uint8Array, publicKeyB64: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "spki",
        fromBase64(publicKeyB64),
        { name: "RSA-OAEP", hash: "SHA-1" },
        false,
        ["encrypt"]
    );
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, data));
    return `${ENC_RSA_2048_OAEP_SHA1_B64}.${toBase64(sealed)}`;
}

/** Open something encrypted to this vault's public key, or null. */
export async function decryptRsa(
    value: string,
    privateKeyPkcs8: Uint8Array
): Promise<Uint8Array | null> {
    const parsed = parseEncString(value);
    if (!parsed) return null;
    // Both OAEP variants appear in the wild; the hash is the only difference.
    const hash = parsed.type === ENC_RSA_2048_OAEP_SHA1_B64 ? "SHA-1" : "SHA-256";
    try {
        const key = await crypto.subtle.importKey(
            "pkcs8",
            privateKeyPkcs8,
            { name: "RSA-OAEP", hash },
            false,
            ["decrypt"]
        );
        const opened = await crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            key,
            fromBase64(parsed.data)
        );
        return new Uint8Array(opened);
    } catch {
        return null;
    }
}

/** What a brand-new vault hands to the server, and nothing more. */
export interface NewVaultKeys {
    masterPasswordHash: string;
    /** The user's key, wrapped under the stretched master key. */
    protectedKey: string;
    publicKey: string;
    /** The private half, wrapped under the user's own key. */
    encryptedPrivateKey: string;
}

/**
 * Set up a vault from a master password: mint the user's key, wrap it, and mint
 * the pair that lets an organization share with them.
 *
 * The master key itself never appears in the result. What the caller gets is the
 * three values the server stores plus the hash that proves the password, which
 * is exactly the set that can be handed over without handing over the vault.
 */
export async function createVaultKeys(
    password: string,
    email: string,
    settings: KdfSettings
): Promise<{ keys: NewVaultKeys; vaultKey: SymmetricKey }> {
    const masterKey = await deriveMasterKey(password, email, settings);
    const stretched = await stretchMasterKey(masterKey);
    const vaultKey = generateSymmetricKey();
    const pair = await generateRsaKeyPair();
    const [protectedKey, encryptedPrivateKey, hash] = await Promise.all([
        encryptBytes(symmetricKeyBytes(vaultKey), stretched),
        encryptBytes(pair.privateKey, vaultKey),
        masterPasswordHash(masterKey, password)
    ]);
    return {
        keys: {
            masterPasswordHash: hash,
            protectedKey,
            publicKey: pair.publicKey,
            encryptedPrivateKey
        },
        vaultKey
    };
}

/**
 * Open a vault: derive, unwrap, and hand back the key everything else is read
 * with. Null when the password is wrong, which is the only thing a wrong
 * password can look like from here - the server was never asked.
 */
export async function unlockVaultKey(
    password: string,
    email: string,
    settings: KdfSettings,
    protectedKey: string
): Promise<SymmetricKey | null> {
    const masterKey = await deriveMasterKey(password, email, settings);
    const stretched = await stretchMasterKey(masterKey);
    const raw = await decryptBytes(protectedKey, stretched);
    if (raw === null || raw.length !== 64) return null;
    return symmetricKeyFromBytes(raw);
}
