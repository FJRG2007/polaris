"use client";

/**
 * What this device keeps of somebody's chat, so it opens without the network.
 *
 * The same rules as the mail cache (`lib/mailbox/mail-cache`), for the same
 * reasons: a messenger that asks the server before it draws anything reads as a
 * website, and one that keeps another account's conversations is a liability.
 *
 * - **Only the signed-in reader's own entries.** Every entry is stamped with the
 *   account it was written for, a read for anybody else answers nothing, and
 *   naming a new owner removes everything that is not theirs at once. Signing
 *   out or switching account drops the whole database (`account-switch`).
 * - **Bounded.** A fixed number of entries per kind, the least recently used
 *   dropped first, and an age past which an entry is worth less than the
 *   skeleton it replaces.
 * - **Never in the way.** No IndexedDB, a private window, a full disk: every
 *   failure answers "nothing kept" and the screen fetches as it always did.
 *
 * Values cross one seam only - `LocalStoreBackend` - so a later layer that
 * encrypts them at rest (and the local search built on it) wraps the backend and
 * nothing above it changes. The bookkeeping is pure and tested without a
 * browser; the IndexedDB half is a thin adapter.
 */

export interface LocalStoreMeta {
    readonly key: string;
    readonly owner: string;
    readonly kind: string;
    readonly id: string;
    /** Last written or read: what least-recently-used eviction orders by. */
    readonly at: number;
    readonly build: string | null;
}

export interface LocalStoreBackend {
    readMeta(): Promise<readonly LocalStoreMeta[]>;
    get(key: string): Promise<{ meta: LocalStoreMeta; value: unknown } | null>;
    put(meta: LocalStoreMeta, value: unknown): Promise<void>;
    touch(meta: LocalStoreMeta): Promise<void>;
    remove(keys: readonly string[]): Promise<void>;
    clear(): Promise<void>;
}

export interface LocalStoreLimit {
    readonly entries: number;
    readonly maxAgeMs: number;
    /** Whether an entry written by another build is unreadable. True for
     *  copies of server data, which the next fetch replaces; false for what only
     *  exists here, like an unsent message, which an update must never lose. */
    readonly buildBound: boolean;
}

export type LocalStoreLimits = Readonly<Record<string, LocalStoreLimit>>;

export function localStoreKey(owner: string, kind: string, id: string): string {
    return `${owner}\u0000${kind}\u0000${id}`;
}

/** Which entries have to go: anybody else's, an unknown kind, anything too old,
 *  and the least recently used of each kind past its limit. */
export function localStoreSurplus(
    entries: readonly LocalStoreMeta[],
    owner: string,
    limits: LocalStoreLimits,
    now: number
): string[] {
    const doomed: string[] = [];
    const kept = new Map<string, LocalStoreMeta[]>();
    for (const entry of entries) {
        const limit = limits[entry.kind];
        if (entry.owner !== owner || !limit || now - entry.at > limit.maxAgeMs) {
            doomed.push(entry.key);
            continue;
        }
        const list = kept.get(entry.kind) ?? [];
        list.push(entry);
        kept.set(entry.kind, list);
    }
    for (const [kind, list] of kept) {
        const surplus = list.length - (limits[kind]?.entries ?? 0);
        if (surplus <= 0) continue;
        const oldest = [...list].sort((a, b) => a.at - b.at).slice(0, surplus);
        for (const entry of oldest) doomed.push(entry.key);
    }
    return doomed;
}

export interface LocalStore {
    /** Whose entries this session reads. Everything else is removed. */
    setOwner(owner: string): void;
    owner(): string;
    read<T>(kind: string, id: string): Promise<T | null>;
    /** Every entry of a kind, oldest written first. */
    readAll<T>(kind: string): Promise<{ id: string; value: T }[]>;
    write(kind: string, id: string, value: unknown): Promise<void>;
    forget(kind: string, id: string): Promise<void>;
    /** Everything, for everybody. What signing out does. */
    clear(): Promise<void>;
}

const PRUNE_AFTER_MS = 2_000;

export function createLocalStore(
    open: () => LocalStoreBackend | null,
    limits: LocalStoreLimits,
    build: () => string | null,
    now: () => number = Date.now
): LocalStore {
    let owner = "";
    let pruning: ReturnType<typeof setTimeout> | null = null;

    const prune = (): void => {
        const backend = open();
        if (!backend || !owner) return;
        const who = owner;
        void backend
            .readMeta()
            .then((entries) => {
                const doomed = localStoreSurplus(entries, who, limits, now());
                return doomed.length > 0 ? backend.remove(doomed) : undefined;
            })
            .catch(() => undefined);
    };
    const pruneSoon = (): void => {
        if (pruning) clearTimeout(pruning);
        pruning = setTimeout(() => {
            pruning = null;
            prune();
        }, PRUNE_AFTER_MS);
    };
    const usable = (meta: LocalStoreMeta, kind: string): boolean => {
        const limit = limits[kind];
        if (!limit || meta.owner !== owner || meta.kind !== kind) return false;
        if (now() - meta.at > limit.maxAgeMs) return false;
        const running = build();
        return !(limit.buildBound && running !== null && meta.build !== running);
    };

    return {
        setOwner(next) {
            if (next === owner) return;
            owner = next;
            // At once: another reader's entries must not outlive the first
            // moment this one is known.
            prune();
        },
        owner: () => owner,
        async read<T>(kind: string, id: string): Promise<T | null> {
            const backend = open();
            if (!backend || !owner) return null;
            try {
                const found = await backend.get(localStoreKey(owner, kind, id));
                if (!found || !usable(found.meta, kind)) return null;
                void backend.touch({ ...found.meta, at: now() }).catch(() => undefined);
                return found.value as T;
            } catch {
                return null;
            }
        },
        async readAll<T>(kind: string): Promise<{ id: string; value: T }[]> {
            const backend = open();
            if (!backend || !owner) return [];
            try {
                const metas = (await backend.readMeta())
                    .filter((meta) => usable(meta, kind))
                    .sort((a, b) => a.at - b.at);
                const found = await Promise.all(metas.map((meta) => backend.get(meta.key)));
                return found.flatMap((entry) =>
                    entry && usable(entry.meta, kind) ? [{ id: entry.meta.id, value: entry.value as T }] : []
                );
            } catch {
                return [];
            }
        },
        async write(kind, id, value) {
            const backend = open();
            if (!backend || !owner || !id || !limits[kind]) return;
            const meta: LocalStoreMeta = {
                key: localStoreKey(owner, kind, id),
                owner,
                kind,
                id,
                at: now(),
                build: build()
            };
            await backend.put(meta, value).then(pruneSoon, () => undefined);
        },
        async forget(kind, id) {
            const backend = open();
            if (!backend || !owner) return;
            await backend.remove([localStoreKey(owner, kind, id)]).catch(() => undefined);
        },
        async clear() {
            if (pruning) clearTimeout(pruning);
            pruning = null;
            owner = "";
            await open()
                ?.clear()
                .catch(() => undefined);
        }
    };
}

/* -------------------------------------------------------------------------- */
/* IndexedDB                                                                   */
/* -------------------------------------------------------------------------- */

const META = "meta";
const DATA = "data";

function answer<T>(request: IDBRequest<T>): Promise<T> {
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

/** An IndexedDB backend for one database, or null where there is none. */
export function indexedDbStore(name: string): () => LocalStoreBackend | null {
    let database: Promise<IDBDatabase> | null = null;
    const connect = (): Promise<IDBDatabase> => {
        database ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
                if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
            };
            request.onsuccess = () => {
                const db = request.result;
                // Another tab deleting the database (a sign-out there) must not
                // be blocked by this one holding it open.
                db.onversionchange = () => {
                    db.close();
                    database = null;
                };
                resolve(db);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error(`${name} blocked`));
        });
        database.catch(() => {
            database = null;
        });
        return database;
    };
    const backend: LocalStoreBackend = {
        async readMeta() {
            const db = await connect();
            return (await answer(db.transaction(META, "readonly").objectStore(META).getAll())) as LocalStoreMeta[];
        },
        async get(key) {
            const db = await connect();
            const transaction = db.transaction([META, DATA], "readonly");
            const [meta, value] = await Promise.all([
                answer(transaction.objectStore(META).get(key)) as Promise<LocalStoreMeta | undefined>,
                answer(transaction.objectStore(DATA).get(key)) as Promise<unknown>
            ]);
            return meta && value !== undefined ? { meta, value } : null;
        },
        async put(meta, value) {
            const db = await connect();
            const transaction = db.transaction([META, DATA], "readwrite");
            transaction.objectStore(META).put(meta);
            transaction.objectStore(DATA).put(value, meta.key);
            await finished(transaction);
        },
        async touch(meta) {
            const db = await connect();
            const transaction = db.transaction(META, "readwrite");
            transaction.objectStore(META).put(meta);
            await finished(transaction);
        },
        async remove(keys) {
            if (keys.length === 0) return;
            const db = await connect();
            const transaction = db.transaction([META, DATA], "readwrite");
            for (const key of keys) {
                transaction.objectStore(META).delete(key);
                transaction.objectStore(DATA).delete(key);
            }
            await finished(transaction);
        },
        async clear() {
            const opened = database;
            database = null;
            if (opened) (await opened.catch(() => null))?.close();
            await new Promise<void>((resolve) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = () => resolve();
                request.onerror = () => resolve();
                request.onblocked = () => resolve();
            });
        }
    };
    return () => {
        try {
            return typeof indexedDB === "undefined" ? null : backend;
        } catch {
            // Some privacy modes throw on merely touching the global.
            return null;
        }
    };
}
