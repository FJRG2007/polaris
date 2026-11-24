/**
 * Keeping what only exists on this device sealed while it waits there: an
 * unsent chat message, a change to one, never readable from a copy of the
 * browser's database.
 *
 *     kept = AES-256-GCM(key, iv = random 96 bits, JSON(value), aad = label)
 *
 * The key is made here, non-extractable, and kept in the same local store as
 * what it seals (the way the sealed search index keeps its own), so it is
 * stamped with the account, bounded with the rest and deleted with it at
 * sign-out. The label names what was sealed (the entry's key), so a sealed
 * value moved to another entry opens to nothing.
 *
 * Where the browser has no WebCrypto (`crypto.subtle` is missing off a secure
 * origin) nothing is sealed: `restKey` answers null and the caller decides
 * whether the value may be kept in the clear at all.
 */

import type { LocalStore } from "@/lib/chat/offline/local-store";

/** The local store kind the key is kept under; the store's limits must name it. */
export const AT_REST_KIND = "rest-key";

export interface SealedAtRest {
    readonly iv: Uint8Array;
    readonly data: Uint8Array;
}

function subtle(): SubtleCrypto | null {
    try {
        return typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;
    } catch {
        return null;
    }
}

const making = new Map<string, Promise<CryptoKey | null>>();

/**
 * This account's key for `name` in `store`, made on first use. Null where
 * there is no WebCrypto, no account, or nowhere to keep the key.
 */
export function restKey(store: LocalStore, name: string): Promise<CryptoKey | null> {
    const owner = store.owner();
    const webCrypto = subtle();
    if (!owner || !webCrypto) return Promise.resolve(null);
    const id = `${owner}\u0000${name}`;
    const known = making.get(id);
    if (known) return known;
    const run = async (): Promise<CryptoKey | null> => {
        const kept = await store.read<CryptoKey>(AT_REST_KIND, name);
        if (kept) return kept;
        const made = await webCrypto.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        if (!(await store.write(AT_REST_KIND, name, made))) return null;
        // Read back: a key that could not be kept must not seal anything.
        return (await store.read<CryptoKey>(AT_REST_KIND, name)) ?? null;
    };
    // One tab at a time, so two tabs never seal under two different keys.
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const pending = (locks ? locks.request(`polaris-rest-key:${id}`, run) : run()).catch(() => null);
    // Shared only while it is being made: read again next time, so a store
    // cleared at sign-out is never sealed to with a key it no longer holds.
    making.set(id, pending);
    void pending.finally(() => making.delete(id));
    return pending;
}

function aad(label: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify(["polaris/offline/at-rest/v1", label]));
}

export async function sealAtRest(key: CryptoKey, value: unknown, label: string): Promise<SealedAtRest> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(value));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(label) }, key, plain));
    plain.fill(0);
    return { iv, data };
}

/** What `kept` was sealed from, or null when it does not open under `key` as `label`. */
export async function openAtRest<T>(key: CryptoKey, kept: SealedAtRest, label: string): Promise<T | null> {
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(kept.iv), additionalData: aad(label) },
            key,
            new Uint8Array(kept.data)
        );
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as T;
    } catch {
        return null;
    }
}
