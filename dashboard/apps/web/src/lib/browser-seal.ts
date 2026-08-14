/**
 * Sealing text in the browser, under a key that never reaches the server.
 *
 * This is what makes a one-time secret actually secret from Polaris: the sender
 * encrypts here, the ciphertext is stored, and the key rides in the URL
 * fragment - the one part of a URL a browser never sends. The recipient's
 * browser reads it back out of the fragment and decrypts locally.
 *
 * The trade is stated wherever it is offered: nothing on the server can preview,
 * search or recover a sealed snippet, and a lost key is a lost secret.
 *
 * AES-256-GCM through WebCrypto - authenticated, so a tampered payload fails to
 * open rather than decrypting into something else. Browser-only: `crypto.subtle`
 * is not available over plain HTTP on a non-local host, which is the same
 * condition every other credential path here already requires.
 */

const ALGORITHM = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12;

/** Bytes to a URL-safe string, and back. */
function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** A fresh key, as the string that goes in the fragment. */
export async function generateSealKey(): Promise<string> {
    const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: KEY_BITS }, true, [
        "encrypt",
        "decrypt"
    ]);
    return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

/** Import a key from its fragment form. */
async function importKey(raw: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", fromBase64Url(raw), ALGORITHM, false, [usage]);
}

/** Seal text under a key. The nonce is prepended, so the payload is self-contained. */
export async function seal(plaintext: string, rawKey: string): Promise<string> {
    const key = await importKey(rawKey, "encrypt");
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: ALGORITHM, iv },
            key,
            new TextEncoder().encode(plaintext)
        )
    );
    const payload = new Uint8Array(iv.length + sealed.length);
    payload.set(iv, 0);
    payload.set(sealed, iv.length);
    return toBase64Url(payload);
}

/**
 * Open a sealed payload, or null when the key is wrong, the payload was
 * tampered with, or it is not a sealed payload at all. Callers say "this link is
 * incomplete" rather than distinguishing those: to somebody holding a broken
 * link they are the same problem, and to an attacker they are a hint.
 */
export async function unseal(payload: string, rawKey: string): Promise<string | null> {
    try {
        const bytes = fromBase64Url(payload);
        if (bytes.length <= IV_BYTES) return null;
        const key = await importKey(rawKey, "decrypt");
        const opened = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv: bytes.subarray(0, IV_BYTES) },
            key,
            bytes.subarray(IV_BYTES)
        );
        return new TextDecoder().decode(opened);
    } catch {
        return null;
    }
}

/** The key in the current URL's fragment (`#k=...`), or null. */
export function keyFromFragment(): string | null {
    if (typeof window === "undefined") return null;
    const fragment = window.location.hash.replace(/^#/, "");
    if (!fragment) return null;
    const key = new URLSearchParams(fragment).get("k");
    return key && key.length > 0 ? key : null;
}

/** Append a seal key to a link, in the part a browser never sends. */
export function withSealKey(url: string, key: string): string {
    return `${url}#k=${key}`;
}
