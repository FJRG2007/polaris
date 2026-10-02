"use client";

/**
 * What this device keeps of somebody's mail between visits.
 *
 * The reason a webmail like Proton or Fastmail feels like an application rather
 * than a website is that it never asks the network before drawing: the mailbox
 * you looked at yesterday is what a mailbox looks like until the server says
 * otherwise. sessionStorage already does that inside one tab (`useLiveRead`);
 * this is the same idea for a new tab, a browser that was closed, and a body
 * somebody read this morning - held in IndexedDB, painted first, and replaced
 * the moment the request behind it lands.
 *
 * What it holds, and the rules that keep it from being a liability:
 *
 * - **Only the signed-in reader's own mail.** Every entry is stamped with the
 *   account it was read for, a read for anybody else answers nothing, and the
 *   first thing a session does is delete every entry that is not its own. A
 *   sign-out drops the whole database (`auth-client`).
 * - **Only what the screen drew.** A message body is stored after the same
 *   sanitizer the reading pane uses (`sanitize`), never as it arrived.
 * - **Bounded.** A fixed number of lists, conversations and bodies, oldest
 *   dropped first, and an age past which an entry is worth less than the
 *   skeleton it replaces. A body's age is under a day because the picture
 *   addresses in it are signed for a day.
 * - **Per mailbox.** Each entry says which mailbox it came from, so removing a
 *   mailbox takes what was kept of it with it.
 * - **Never in the way.** Every failure - no IndexedDB, a private window, a
 *   full disk, a schema from another build - answers "nothing kept", and the
 *   screen fetches exactly as it would have.
 *
 * The bookkeeping is pure and runs over a small interface, so the rules above
 * are tested without a browser; the IndexedDB half is a thin adapter.
 */

import { snapshotBuild } from "@/lib/snapshot-cache";

export type MailCacheKind = "list" | "thread" | "message";

/** What is known about an entry without reading its value. */
export interface MailCacheMeta {
    readonly key: string;
    readonly owner: string;
    readonly kind: MailCacheKind;
    /** The mailbox it came from, or "" for a merged list that spans several. */
    readonly accountId: string;
    readonly at: number;
    readonly build: string | null;
}

export interface MailCacheBackend {
    readMeta(): Promise<readonly MailCacheMeta[]>;
    get(key: string): Promise<{ meta: MailCacheMeta; value: unknown } | null>;
    put(meta: MailCacheMeta, value: unknown): Promise<void>;
    remove(keys: readonly string[]): Promise<void>;
    clear(): Promise<void>;
}

/** How much of each is kept, and for how long it is worth painting. */
export const MAIL_CACHE_LIMITS: Readonly<
    Record<MailCacheKind, { entries: number; maxAgeMs: number }>
> = {
    list: { entries: 40, maxAgeMs: 7 * 24 * 3_600_000 },
    thread: { entries: 150, maxAgeMs: 7 * 24 * 3_600_000 },
    // Under a day: the picture addresses inside a body are signed for one.
    message: { entries: 150, maxAgeMs: 20 * 3_600_000 }
};

export function mailCacheKey(owner: string, kind: MailCacheKind, id: string): string {
    return `${owner}\u0000${kind}\u0000${id}`;
}

/**
 * Which entries have to go: anybody else's, anything from a mailbox that is no
 * longer linked, anything too old, and the oldest of each kind past its limit.
 *
 * `accounts` null means the mailboxes are not known yet, which removes nothing
 * on their account.
 */
export function mailCacheSurplus(
    entries: readonly MailCacheMeta[],
    owner: string,
    accounts: ReadonlySet<string> | null,
    now: number
): string[] {
    const doomed: string[] = [];
    const kept: Record<MailCacheKind, MailCacheMeta[]> = { list: [], thread: [], message: [] };
    for (const entry of entries) {
        const limits = MAIL_CACHE_LIMITS[entry.kind];
        const foreign = entry.owner !== owner;
        const unlinked =
            accounts !== null && entry.accountId !== "" && !accounts.has(entry.accountId);
        const old = !limits || now - entry.at > limits.maxAgeMs;
        if (foreign || unlinked || old) doomed.push(entry.key);
        else kept[entry.kind].push(entry);
    }
    for (const kind of Object.keys(kept) as MailCacheKind[]) {
        const surplus = kept[kind].length - MAIL_CACHE_LIMITS[kind].entries;
        if (surplus <= 0) continue;
        const oldest = [...kept[kind]].sort((a, b) => a.at - b.at).slice(0, surplus);
        for (const entry of oldest) doomed.push(entry.key);
    }
    return doomed;
}

export interface MailCache {
    /** Whose mail this session is reading. Everything else is removed. */
    setOwner(owner: string): void;
    /** The mailboxes that are linked now. What came from any other is removed. */
    setAccounts(accountIds: readonly string[]): void;
    read<T>(kind: MailCacheKind, id: string): Promise<T | null>;
    write(kind: MailCacheKind, id: string, value: unknown, accountId: string): void;
    forget(kind: MailCacheKind, id: string): void;
    /** Everything, for everybody. What signing out does. */
    clear(): Promise<void>;
}

/** How long writes settle before the bookkeeping runs: one pass for a burst. */
const PRUNE_AFTER_MS = 2_000;

export function createMailCache(
    open: () => MailCacheBackend | null,
    build: () => string | null,
    now: () => number = Date.now
): MailCache {
    let owner = "";
    let accounts: ReadonlySet<string> | null = null;
    let pruning: ReturnType<typeof setTimeout> | null = null;

    const prune = (): void => {
        const backend = open();
        if (!backend || !owner) return;
        const who = owner;
        void backend
            .readMeta()
            .then((entries) => {
                const doomed = mailCacheSurplus(entries, who, accounts, now());
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

    return {
        setOwner(next) {
            if (next === owner) return;
            owner = next;
            accounts = null;
            // At once rather than after a pause: another reader's entries
            // must not outlive the first moment this one is known.
            prune();
        },
        setAccounts(accountIds) {
            const next = new Set(accountIds);
            if (
                accounts &&
                accounts.size === next.size &&
                [...next].every((id) => accounts?.has(id))
            ) {
                return;
            }
            accounts = next;
            pruneSoon();
        },
        async read<T>(kind: MailCacheKind, id: string): Promise<T | null> {
            const backend = open();
            if (!backend || !owner) return null;
            try {
                const found = await backend.get(mailCacheKey(owner, kind, id));
                if (!found) return null;
                const { meta } = found;
                // Belt and braces: the key already names the owner, and this is
                // the one rule that must not depend on a key being built right.
                if (meta.owner !== owner || meta.kind !== kind) return null;
                if (now() - meta.at > MAIL_CACHE_LIMITS[kind].maxAgeMs) return null;
                // Written by a build that is no longer running: its shape is not
                // this code's to read. See `snapshot-cache`.
                const running = build();
                if (running !== null && meta.build !== running) return null;
                if (accounts && meta.accountId && !accounts.has(meta.accountId)) return null;
                return found.value as T;
            } catch {
                return null;
            }
        },
        write(kind, id, value, accountId) {
            const backend = open();
            if (!backend || !owner || !id) return;
            const meta: MailCacheMeta = {
                key: mailCacheKey(owner, kind, id),
                owner,
                kind,
                accountId,
                at: now(),
                build: build()
            };
            void backend.put(meta, value).then(pruneSoon, () => undefined);
        },
        forget(kind, id) {
            const backend = open();
            if (!backend || !owner) return;
            void backend.remove([mailCacheKey(owner, kind, id)]).catch(() => undefined);
        },
        async clear() {
            if (pruning) clearTimeout(pruning);
            pruning = null;
            owner = "";
            accounts = null;
            await open()
                ?.clear()
                .catch(() => undefined);
        }
    };
}

/* -------------------------------------------------------------------------- */
/* IndexedDB                                                                   */
/* -------------------------------------------------------------------------- */

const DB_NAME = "polaris-mail";
const META = "meta";
const DATA = "data";

let database: Promise<IDBDatabase> | null = null;

function connect(): Promise<IDBDatabase> {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
            if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
        };
        request.onsuccess = () => {
            const db = request.result;
            // Another tab deleting the database (a sign-out there) must not be
            // blocked by this one holding it open.
            db.onversionchange = () => {
                db.close();
                database = null;
            };
            resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("mail cache blocked"));
    });
    database.catch(() => {
        database = null;
    });
    return database;
}

function finished(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

function answer<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const indexedDbBackend: MailCacheBackend = {
    async readMeta() {
        const db = await connect();
        return (await answer(
            db.transaction(META, "readonly").objectStore(META).getAll()
        )) as MailCacheMeta[];
    },
    async get(key) {
        const db = await connect();
        const transaction = db.transaction([META, DATA], "readonly");
        const [meta, value] = await Promise.all([
            answer(transaction.objectStore(META).get(key)) as Promise<MailCacheMeta | undefined>,
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
        const open = database;
        database = null;
        if (open) (await open.catch(() => null))?.close();
        await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(DB_NAME);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
        });
    }
};

function backendHere(): MailCacheBackend | null {
    try {
        return typeof indexedDB === "undefined" ? null : indexedDbBackend;
    } catch {
        // Some privacy modes throw on merely touching the global.
        return null;
    }
}

export const mailCache = createMailCache(backendHere, snapshotBuild);

/** Forget everything this device kept of anybody's mail. What signing out does. */
export function dropMailCache(): Promise<void> {
    return mailCache.clear();
}
