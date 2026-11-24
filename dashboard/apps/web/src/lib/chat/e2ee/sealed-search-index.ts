/**
 * Searching sealed text on the device (docs/chat-e2ee-mls.md, "Other places a
 * message is shown" -> Search). The server holds an empty body for a sealed
 * message, so its words can only be found where they were opened: every
 * sealed message this browser opens (or sends, or edits) is kept here, and a
 * search with words looks here first, then asks the server for those
 * messages by id under the same reach, lock and history rules as any search.
 *
 * Never stored in the clear: each entry is sealed under a non-extractable
 * AES-256-GCM key kept in the same database, the way the history-key store
 * keeps its wrapping key, so a copy of the database opens nothing elsewhere.
 *
 *     sealed = AES-256-GCM(wrap, iv = random 96 bits, {c, e, b}, aad = [LABEL, device, id])
 *
 * The additional data names the message, so an entry moved to another key
 * opens to nothing. The conversation is inside the seal, not beside it; only
 * the message id and the time of its last edit are beside it. The
 * nonce is random: one key seals at most a few `INDEX_LIMIT`s of entries in
 * practice, far under the 2^32 a random 96-bit nonce allows.
 *
 * One database per device (`polaris-mls-search/<device>`), deleted with the
 * device when its account signs out of this browser. At most `INDEX_LIMIT`
 * entries, the oldest (message ids are UUIDv7, so the lowest) dropped first.
 * A message the server says is gone (deleted, or in a conversation this
 * account no longer reaches) is dropped when a search finds it.
 */

const PREFIX = "polaris-mls-search/";
const WRAP = "wrap";
const ENTRIES = "entries";
const WRAP_RECORD = "wrap";
const LABEL = "polaris/chat-e2ee/search-index/v1";
const MAX_DEVICE_LENGTH = 200;
/** How many opened messages one device keeps searchable. */
export const INDEX_LIMIT = 20_000;
/**
 * How many matches one search hands the server to put through its rules
 * (reach, lock, filters): more than a page of hits, since some will not pass.
 */
export const SEARCH_CANDIDATES = 200;

/** One opened sealed message, as the index keeps it. */
export interface IndexedSealed {
    readonly id: string;
    readonly channelId: string;
    /** When the version kept was last edited (absent if never). */
    readonly editedAt?: string;
    readonly body: string;
}

interface StoredEntry {
    readonly iv: Uint8Array;
    readonly sealed: Uint8Array;
    /** The version kept (its last edit, empty if never), beside the seal so a
     *  version already kept is not sealed again on every page that opens it.
     *  The server holds the same time for the row. */
    readonly version: string;
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

/** How a body and a term are compared: case and composition folded, as the server's insensitive match does. */
export function foldForSearch(text: string): string {
    return text.normalize("NFKC").toLowerCase();
}

/** Whether `body` holds the words searched for (the whole term, as one run, like the server's match). */
export function bodyMatches(body: string, term: string): boolean {
    const wanted = foldForSearch(term.trim());
    return wanted.length > 0 && foldForSearch(body).includes(wanted);
}

/** Whether `next` (a version's last edit) is at least as new as `kept`. */
function newerOrSame(next: string | undefined, kept: string | undefined): boolean {
    if (!kept) return true;
    return Boolean(next) && next! >= kept;
}

export class SealedSearchIndex {
    /** Everything this page knows the index holds, by message id. */
    private readonly entries = new Map<string, IndexedSealed & { readonly folded: string }>();
    private loading: Promise<void> | null = null;

    private constructor(
        private readonly db: IDBDatabase,
        private readonly device: string,
        private readonly wrap: CryptoKey
    ) {
        db.onversionchange = () => db.close();
    }

    /** Open the device's index, making its key on first use. */
    static async open(device: string, factory: IDBFactory = globalThis.indexedDB): Promise<SealedSearchIndex> {
        const request = factory.open(databaseName(device), 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(WRAP)) db.createObjectStore(WRAP);
            if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES);
        };
        const db = await done(request);
        const known = (await done(db.transaction(WRAP, "readonly").objectStore(WRAP).get(WRAP_RECORD))) as CryptoKey | undefined;
        if (known) return new SealedSearchIndex(db, device, known);
        const made = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const write = db.transaction(WRAP, "readwrite", { durability: "strict" });
        // `add`: a second tab that made its own key first keeps it, and this one reads it back.
        write.objectStore(WRAP).add(made, WRAP_RECORD);
        await finished(write).catch(() => undefined);
        const settled = (await done(db.transaction(WRAP, "readonly").objectStore(WRAP).get(WRAP_RECORD))) as CryptoKey | undefined;
        if (!settled) throw new Error("the search index could not keep its key");
        return new SealedSearchIndex(db, device, settled);
    }

    /** Delete a device's index and everything in it. */
    static async destroy(device: string, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
        await done(factory.deleteDatabase(databaseName(device)));
    }

    /** Keep an opened message searchable; an older version than the one kept is ignored. */
    async record(entry: IndexedSealed): Promise<void> {
        const kept = this.entries.get(entry.id);
        if (kept && (kept.editedAt === entry.editedAt || !newerOrSame(entry.editedAt, kept.editedAt))) return;
        if (!kept) {
            const stored = (await done(this.db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).get(entry.id))) as StoredEntry | undefined;
            const version = typeof stored?.version === "string" ? stored.version || undefined : null;
            // This version, or a newer one, is already kept: read with the rest when a search loads them.
            if (stored && version !== null && (version === entry.editedAt || !newerOrSame(entry.editedAt, version))) return;
        }
        this.remember(entry);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plain = new TextEncoder().encode(JSON.stringify({ c: entry.channelId, e: entry.editedAt ?? null, b: entry.body }));
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad(entry.id) }, this.wrap, plain));
        plain.fill(0);
        const transaction = this.db.transaction(ENTRIES, "readwrite");
        transaction.objectStore(ENTRIES).put({ iv, sealed, version: entry.editedAt ?? "" } satisfies StoredEntry, entry.id);
        await finished(transaction);
        if (this.loading && this.entries.size > INDEX_LIMIT) await this.trim();
    }

    /**
     * The ids of kept messages whose text holds `term`, newest first, in
     * `channelId` when one is named; at most `limit`.
     */
    async search(term: string, channelId: string | null, limit: number): Promise<string[]> {
        await this.load();
        const wanted = foldForSearch(term.trim());
        if (!wanted) return [];
        const out: string[] = [];
        // Newest first: UUIDv7 ids sort by when they were made.
        for (const id of [...this.entries.keys()].sort().reverse()) {
            const entry = this.entries.get(id)!;
            if (channelId && entry.channelId !== channelId) continue;
            if (!entry.folded.includes(wanted)) continue;
            out.push(id);
            if (out.length >= limit) break;
        }
        return out;
    }

    /** Drop these messages (deleted, or no longer reachable). */
    async forget(ids: readonly string[]): Promise<void> {
        if (!ids.length) return;
        for (const id of ids) this.entries.delete(id);
        const transaction = this.db.transaction(ENTRIES, "readwrite");
        const store = transaction.objectStore(ENTRIES);
        for (const id of ids) store.delete(id);
        await finished(transaction);
    }

    close(): void {
        this.db.close();
    }

    private remember(entry: IndexedSealed): void {
        const { id, channelId, editedAt, body } = entry;
        this.entries.set(id, { id, channelId, ...(editedAt ? { editedAt } : {}), body, folded: foldForSearch(body) });
    }

    /** Read every kept entry into the page once; what this page recorded meanwhile stays where newer. */
    private load(): Promise<void> {
        this.loading ??= (async () => {
            const transaction = this.db.transaction(ENTRIES, "readonly");
            const store = transaction.objectStore(ENTRIES);
            const [keys, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
            const unreadable: string[] = [];
            for (let index = 0; index < keys.length; index += 1) {
                const id = String(keys[index]);
                const opened = await this.openEntry(id, values[index] as StoredEntry);
                if (!opened) {
                    unreadable.push(id);
                    continue;
                }
                const kept = this.entries.get(id);
                if (!kept || !newerOrSame(kept.editedAt, opened.editedAt)) this.remember(opened);
            }
            await this.forget(unreadable);
            await this.trim();
        })().catch((caught: unknown) => {
            this.loading = null;
            throw caught;
        });
        return this.loading;
    }

    /** Keep the newest `INDEX_LIMIT` entries. */
    private async trim(): Promise<void> {
        if (this.entries.size <= INDEX_LIMIT) return;
        const oldest = [...this.entries.keys()].sort().slice(0, this.entries.size - INDEX_LIMIT);
        await this.forget(oldest);
    }

    private async openEntry(id: string, stored: StoredEntry | undefined): Promise<IndexedSealed | null> {
        if (!stored?.iv || !stored.sealed) return null;
        try {
            const plain = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(stored.iv), additionalData: this.aad(id) },
                this.wrap,
                new Uint8Array(stored.sealed)
            );
            const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as { c?: unknown; e?: unknown; b?: unknown };
            if (typeof parsed.c !== "string" || typeof parsed.b !== "string" || (parsed.e !== null && typeof parsed.e !== "string")) return null;
            return { id, channelId: parsed.c, ...(parsed.e ? { editedAt: parsed.e } : {}), body: parsed.b };
        } catch {
            // Sealed under a key this database no longer holds, or not an entry this version wrote.
            return null;
        }
    }

    private aad(id: string): Uint8Array<ArrayBuffer> {
        return new TextEncoder().encode(JSON.stringify([LABEL, this.device, id]));
    }
}
