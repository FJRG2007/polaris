/**
 * A device's MLS state in IndexedDB (docs/rust-core-plan.md, E2).
 *
 * An `MlsMember` runs over in-memory storage; after each operation the host
 * takes `member.storeChanges()` and hands the list to `commit`, which applies
 * it in ONE readwrite transaction together with whatever the operation must
 * send (the outbox). A page killed before that transaction completes restarts
 * as if the operation never happened; one killed after it restarts with the
 * operation applied and its messages still in the outbox, to be sent again.
 * IndexedDB never leaves a transaction half applied, so there is no state in
 * between (crates/polaris-core/src/mls/journal.rs).
 *
 * Each device has a database of its own, so two accounts on one browser never
 * share a store and signing one out deletes exactly its database (`destroy`).
 */

const STATE = "state";
const OUTBOX = "outbox";
const PREFIX = "polaris-mls/";
const MAX_DEVICE_LENGTH = 200;

/** One key's change from `MlsMember.storeChanges()`; no value means deleted. */
export interface MlsStoreChange {
    key: Uint8Array;
    value?: Uint8Array | null;
}

/** A message an operation produced, persisted with it until it is sent. */
export interface MlsOutboxEntry {
    id: number;
    message: Uint8Array;
}

/** Everything a restart needs: the arguments of `MlsMember.restore` and the outbox. */
export interface MlsStoreSnapshot {
    keys: Uint8Array[];
    values: Uint8Array[];
    outbox: MlsOutboxEntry[];
}

function databaseName(device: string): string {
    if (typeof device !== "string" || !device.trim() || device.length > MAX_DEVICE_LENGTH)
        throw new TypeError(`the device id must be a non-empty string of at most ${MAX_DEVICE_LENGTH} characters`);
    return PREFIX + device;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

function finished(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
}

function bytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("the MLS store holds a value that is not bytes");
}

export class IndexedDbMlsStore {
    private constructor(private readonly db: IDBDatabase) {
        // Another tab deleting this device (sign-out) must not wait on us.
        db.onversionchange = () => db.close();
    }

    /** Open (creating on first use) the store of one device. */
    static async open(device: string, factory: IDBFactory = globalThis.indexedDB): Promise<IndexedDbMlsStore> {
        const request = factory.open(databaseName(device), 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
            if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { autoIncrement: true });
        };
        return new IndexedDbMlsStore(await done(request));
    }

    /** Delete a device's store, every key and the outbox with it. */
    static async destroy(device: string, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
        await done(factory.deleteDatabase(databaseName(device)));
    }

    /** The whole store, read in one transaction so keys and values match. */
    async load(): Promise<MlsStoreSnapshot> {
        const transaction = this.db.transaction([STATE, OUTBOX], "readonly");
        const state = transaction.objectStore(STATE);
        const outbox = transaction.objectStore(OUTBOX);
        const [keys, values, ids, messages] = await Promise.all([
            done(state.getAllKeys()),
            done(state.getAll()),
            done(outbox.getAllKeys()),
            done(outbox.getAll())
        ]);
        await finished(transaction);
        return {
            keys: keys.map(bytes),
            values: values.map(bytes),
            outbox: ids.map((id, i) => ({ id: Number(id), message: bytes(messages[i]) }))
        };
    }

    /**
     * Apply one operation's changes and queue its messages, all or nothing.
     * Resolves once the transaction is durable; only then may the messages be
     * handed out. A rejection means nothing was written: drop the member and
     * restore it from `load()`, exactly as after a crash.
     */
    async commit(changes: readonly MlsStoreChange[], messages: readonly Uint8Array[] = []): Promise<number[]> {
        if (!changes.length && !messages.length) return [];
        const transaction = this.db.transaction([STATE, OUTBOX], "readwrite", { durability: "strict" });
        const state = transaction.objectStore(STATE);
        const outbox = transaction.objectStore(OUTBOX);
        for (const change of changes) {
            if (change.value == null) state.delete(change.key);
            else state.put(change.value, change.key);
        }
        const added = messages.map((message) => outbox.add(message));
        await finished(transaction);
        return added.map((request) => Number(request.result));
    }

    /** Drop a message from the outbox once the delivery service accepted it. */
    async sent(id: number): Promise<void> {
        const transaction = this.db.transaction(OUTBOX, "readwrite", { durability: "strict" });
        transaction.objectStore(OUTBOX).delete(id);
        await finished(transaction);
    }

    close(): void {
        this.db.close();
    }
}
