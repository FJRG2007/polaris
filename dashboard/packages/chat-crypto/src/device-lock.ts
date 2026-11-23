/**
 * The device lock (design 3.2, first row): the account key sealed under a key
 * this browser holds as a non-extractable `CryptoKey` in IndexedDB.
 *
 * One database per account (`polaris-chat-keys:<userId>`), so several accounts
 * in one browser never share a store (3.3, "Varias cuentas") and signing one
 * out deletes exactly its database and nothing else.
 *
 * Both the key and its envelope stay in this browser: the envelope is useless
 * without the key, and the key cannot be read out of WebCrypto by script - a
 * copy of the database on another machine opens nothing, because a
 * non-extractable key's bytes are not part of what script can export.
 */

import { owned, randomBytes } from "./bytes";
import { importLockSecret, openAccountKey, sealAccountKey, type LockBinding } from "./locks";

const DATABASE_PREFIX = "polaris-chat-keys:";
const STORE = "keys";
const RECORD = "device-lock";
/** The device lock's id inside its binding. One lock per account per browser. */
export const DEVICE_LOCK_ID = "device";

/** What the store keeps for one account. */
export interface DeviceLockRecord {
    readonly key: CryptoKey;
    readonly envelope: Uint8Array;
    readonly akVersion: number;
}

/** Where device locks live. IndexedDB in a browser; tests may supply another. */
export interface DeviceLockStore {
    read(userId: string): Promise<DeviceLockRecord | null>;
    write(userId: string, record: DeviceLockRecord): Promise<void>;
    forget(userId: string): Promise<void>;
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function databaseName(userId: string): string {
    if (!userId) throw new RangeError("A device lock belongs to an account");
    return `${DATABASE_PREFIX}${userId}`;
}

function open(factory: IDBFactory, userId: string): Promise<IDBDatabase> {
    const request = factory.open(databaseName(userId), 1);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
            request.result.createObjectStore(STORE);
    };
    return requestDone(request);
}

/** The IndexedDB store, over the given factory (the global one by default). */
export function indexedDbDeviceLockStore(
    factory: IDBFactory = globalThis.indexedDB
): DeviceLockStore {
    return {
        async read(userId) {
            const db = await open(factory, userId);
            try {
                const value = (await requestDone(
                    db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD)
                )) as DeviceLockRecord | undefined;
                return value ?? null;
            } finally {
                db.close();
            }
        },
        async write(userId, record) {
            const db = await open(factory, userId);
            try {
                const transaction = db.transaction(STORE, "readwrite");
                transaction.objectStore(STORE).put(record, RECORD);
                await new Promise<void>((resolve, reject) => {
                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error);
                    transaction.onabort = () => reject(transaction.error);
                });
            } finally {
                db.close();
            }
        },
        async forget(userId) {
            await requestDone(factory.deleteDatabase(databaseName(userId)));
        }
    };
}

function bindingFor(userId: string, akVersion: number): LockBinding {
    return { userId, kind: "device", lockId: DEVICE_LOCK_ID, akVersion };
}

/**
 * Seal the account key under a brand-new device key and keep both.
 *
 * The key's raw bytes exist for the length of one import and are zeroed after;
 * from then on only the non-extractable handle exists.
 */
export async function createDeviceLock(
    store: DeviceLockStore,
    userId: string,
    accountKey: Uint8Array,
    akVersion: number
): Promise<void> {
    const secret = randomBytes(32);
    const key = await importLockSecret(secret);
    secret.fill(0);
    const envelope = await sealAccountKey(accountKey, key, bindingFor(userId, akVersion));
    await store.write(userId, { key, envelope: owned(envelope), akVersion });
}

/** The account key from this browser's device lock, or null when it has none. */
export async function openDeviceLock(
    store: DeviceLockStore,
    userId: string
): Promise<{ accountKey: Uint8Array; akVersion: number } | null> {
    const record = await store.read(userId);
    if (!record) return null;
    const accountKey = await openAccountKey(
        record.envelope,
        record.key,
        bindingFor(userId, record.akVersion)
    );
    return { accountKey, akVersion: record.akVersion };
}

/** Sign-out: this account's keys leave this browser; other accounts are untouched. */
export async function forgetDeviceLock(store: DeviceLockStore, userId: string): Promise<void> {
    await store.forget(userId);
}

/**
 * "Sign out of all": every account's keys leave this browser. Browsers that
 * cannot list their databases leave the others for each account's own
 * sign-out; a failure to delete one never stops the rest.
 */
export async function forgetEveryDeviceLock(factory: IDBFactory = globalThis.indexedDB): Promise<void> {
    if (typeof factory?.databases !== "function") return;
    const names = (await factory.databases()).map((info) => info.name ?? "");
    await Promise.all(
        names
            .filter((name) => name.startsWith(DATABASE_PREFIX) && name.length > DATABASE_PREFIX.length)
            .map((name) => requestDone(factory.deleteDatabase(name)).catch(() => undefined))
    );
}
