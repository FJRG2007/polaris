/**
 * The history keys an MLS device has read or made, kept across restarts
 * (docs/chat-e2ee-mls.md). Without this a device whose account key is locked
 * loses every `HK` it held when the page closes, and with it the conversation's
 * past.
 *
 * Never stored in the clear: each key is sealed under a key this browser holds
 * as a non-extractable `CryptoKey` in the same database, the way the device
 * lock keeps the account key (`@polaris/chat-crypto/device-lock`). A copy of
 * the database opens nothing elsewhere, since script cannot export that key.
 *
 *     K, nonce = HKDF-SHA256(wrap, salt = empty, info = [LABEL, device, conversation, epoch])
 *     sealed   = AES-256-GCM(K, nonce, HK, aad = info)
 *
 * The key and nonce come from the derivation (no bare random nonce), so a slot
 * is written once: a second write for the same conversation and epoch is
 * dropped rather than sealing a different key under the same nonce.
 *
 * One database per device (`polaris-mls-history/<device>`), deleted with the
 * device when its account signs out of this browser.
 */

const PREFIX = "polaris-mls-history/";
const WRAP = "wrap";
const KEYS = "keys";
const WRAP_RECORD = "wrap";
const LABEL = "polaris/chat-e2ee/history-key-at-rest/v1";
const HISTORY_KEY_BYTES = 32;
const MAX_DEVICE_LENGTH = 200;

/** What `MlsDevice` needs of a history-key store. */
export interface MlsHistoryKeyStore {
    get(channelId: string, epoch: bigint): Promise<Uint8Array | null>;
    /** Keep `key` for the slot; a slot already written keeps what it has. */
    put(channelId: string, epoch: bigint, key: Uint8Array): Promise<void>;
}

function databaseName(device: string): string {
    if (typeof device !== "string" || !device.trim() || device.length > MAX_DEVICE_LENGTH)
        throw new TypeError(`the device id must be a non-empty string of at most ${MAX_DEVICE_LENGTH} characters`);
    return `${PREFIX}${device}`;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function finished(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

const slot = (channelId: string, epoch: bigint) => `${channelId}/${epoch}`;

export class IndexedDbHistoryKeyStore implements MlsHistoryKeyStore {
    private constructor(
        private readonly db: IDBDatabase,
        private readonly device: string,
        private readonly wrap: CryptoKey
    ) {
        db.onversionchange = () => db.close();
    }

    /** Open the device's store, making its wrapping key on first use. */
    static async open(device: string, factory: IDBFactory = globalThis.indexedDB): Promise<IndexedDbHistoryKeyStore> {
        const request = factory.open(databaseName(device), 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(WRAP)) db.createObjectStore(WRAP);
            if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
        };
        const db = await done(request);
        const read = db.transaction(WRAP, "readonly");
        const known = (await done(read.objectStore(WRAP).get(WRAP_RECORD))) as CryptoKey | undefined;
        if (known) return new IndexedDbHistoryKeyStore(db, device, known);
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const made = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
        raw.fill(0);
        const write = db.transaction(WRAP, "readwrite", { durability: "strict" });
        // `add`: a second tab that made its own key first keeps it, and this one reads it back.
        write.objectStore(WRAP).add(made, WRAP_RECORD);
        await finished(write).catch(() => undefined);
        const settled = (await done(db.transaction(WRAP, "readonly").objectStore(WRAP).get(WRAP_RECORD))) as CryptoKey | undefined;
        if (!settled) throw new Error("the history-key store could not keep its wrapping key");
        return new IndexedDbHistoryKeyStore(db, device, settled);
    }

    /** Delete a device's store and every history key in it. */
    static async destroy(device: string, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
        await done(factory.deleteDatabase(databaseName(device)));
    }

    async get(channelId: string, epoch: bigint): Promise<Uint8Array | null> {
        const sealed = (await done(this.db.transaction(KEYS, "readonly").objectStore(KEYS).get(slot(channelId, epoch)))) as Uint8Array | undefined;
        if (!sealed) return null;
        const [key, iv, aad] = await this.derive(channelId, epoch);
        try {
            const opened = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new Uint8Array(sealed)));
            return opened.length === HISTORY_KEY_BYTES ? opened : null;
        } catch {
            // Sealed under a wrapping key this database no longer holds: as if never kept.
            return null;
        }
    }

    async put(channelId: string, epoch: bigint, historyKey: Uint8Array): Promise<void> {
        if (historyKey.length !== HISTORY_KEY_BYTES) throw new RangeError("A history key is 32 bytes");
        const [key, iv, aad] = await this.derive(channelId, epoch);
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new Uint8Array(historyKey)));
        const transaction = this.db.transaction(KEYS, "readwrite", { durability: "strict" });
        const request = transaction.objectStore(KEYS).add(sealed, slot(channelId, epoch));
        // Already written: the slot keeps its key (see the header).
        request.onerror = (event) => {
            if (request.error?.name !== "ConstraintError") return;
            // Handled: neither abort the transaction nor reach its error handler.
            event.preventDefault();
            event.stopPropagation();
        };
        await finished(transaction);
    }

    close(): void {
        this.db.close();
    }

    private async derive(channelId: string, epoch: bigint): Promise<[CryptoKey, Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>]> {
        if (!channelId || epoch < 0n) throw new RangeError("A history key names its conversation and a non-negative epoch");
        const info = new TextEncoder().encode(JSON.stringify([LABEL, this.device, channelId, epoch.toString()]));
        const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, this.wrap, 44 * 8));
        const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
        const iv = bits.slice(32);
        bits.fill(0);
        return [key, iv, info];
    }
}
