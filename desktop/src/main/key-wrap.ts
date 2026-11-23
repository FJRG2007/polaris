/**
 * The chat account key's device lock under the operating system's key store
 * (docs/chat-e2ee-phase1.md, "Native key stores").
 *
 * The page seals one small envelope at a time with `safeStorage` - DPAPI on
 * Windows, the Keychain on macOS, the secret service on Linux - so the copy in
 * the browser profile opens nothing without this operating system account.
 * Each sealed value is bound to the server it was sealed for: the origin is
 * part of what is encrypted, so a value one Polaris sealed never opens for
 * another, even inside this app.
 *
 * Refuses on a Linux desktop with no secret service, where `safeStorage`
 * would fall back to a fixed key: the page then keeps its own device lock, as
 * a plain browser does, instead of trusting a wrap that protects nothing.
 * Every refusal is a null, never a thrown error the page would have to read.
 */

/** The part of Electron's `safeStorage` this needs, so the tests can stand in for it. */
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend?(): string;
    encryptString(plain: string): Buffer;
    decryptString(sealed: Buffer): string;
}

/** Base64url, no padding; the most is a sealed envelope well under 4 KiB. */
const TEXT = /^[A-Za-z0-9_-]{1,4096}$/;
const SEPARATOR = "\n";

/** Whether this computer can seal anything worth sealing. */
export function canWrapKeys(storage: SafeStorageLike, platform: string = process.platform): boolean {
    try {
        if (!storage.isEncryptionAvailable()) return false;
        return platform !== "linux" || storage.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
        return false;
    }
}

function originOf(origin: unknown): string | null {
    if (typeof origin !== "string") return null;
    const parsed = URL.parse(origin);
    return parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.origin : null;
}

/** Seal `data` (base64url) for `origin`; null when it cannot. */
export function sealKey(storage: SafeStorageLike, origin: unknown, data: unknown, platform?: string): string | null {
    const server = originOf(origin);
    if (!server || typeof data !== "string" || !TEXT.test(data) || !canWrapKeys(storage, platform)) return null;
    try {
        return storage.encryptString(`${server}${SEPARATOR}${data}`).toString("base64url");
    } catch {
        return null;
    }
}

/** Open what `sealKey` sealed for this same `origin`; null for anything else. */
export function openKey(storage: SafeStorageLike, origin: unknown, sealed: unknown, platform?: string): string | null {
    const server = originOf(origin);
    if (!server || typeof sealed !== "string" || !TEXT.test(sealed) || !canWrapKeys(storage, platform)) return null;
    try {
        const plain = storage.decryptString(Buffer.from(sealed, "base64url"));
        const cut = plain.indexOf(SEPARATOR);
        if (cut < 0 || plain.slice(0, cut) !== server) return null;
        const data = plain.slice(cut + 1);
        return TEXT.test(data) ? data : null;
    } catch {
        return null;
    }
}
