/**
 * The MLS device of a member the server runs - Polar in one conversation, or
 * one webhook (docs/chat-e2ee-mls.md, "Server-run members"). The same
 * `MlsDevice` a browser runs, over the Node binding's `MlsMember`, with:
 *
 * - **Its store in `MlsStoreEntry`** (`mls-store.ts`), under the device's full
 *   address. The outbox, the notes (signature key, group id, log cursor) and
 *   the history keys it holds live beside the member's own keys under the
 *   reserved prefix, so an operation's changes and the request it has to send
 *   commit in ONE transaction, and every value is sealed under the master key.
 * - **An in-process transport**: each op runs through `answerMls` as the
 *   service account, with no session and no route, and is checked exactly as
 *   a person's is (`channelAccess` answers a service account).
 * - **One writer**: two server instances running the same device would fork
 *   its ratchet, so the device is opened only under a lease on its address
 *   (`withLease`), and one process runs its work one at a time.
 *
 * Nothing here runs while `chatE2eeEnabled()` is off: `answerMls` answers 404,
 * and `withServiceDevice` refuses before it loads anything.
 *
 * Server-only.
 */

import { chatE2eeEnabled } from "./flag";
import type { MlsBody } from "./schemas";
import { answerMls } from "./mls-handler";
import { withLease } from "@/lib/cron/lease";
import { nativeMlsMember } from "@polaris/core-rs";
import type { MlsHistoryKeyStore } from "./mls-history-keys";
import { commitMlsStore, destroyMlsStore, loadMlsStore, reservedKey, type MlsStoreChange } from "./mls-store";
import { POLAR_SERVICE_ID, WEBHOOK_SERVICE_ID, serviceDevice, type ServiceKind } from "@/lib/chat/service-members";
import { MlsDevice, MlsRequestError, signatureNoteKey, type MlsDeviceNotes, type MlsDeviceStore, type MlsMemberClass, type MlsTransport } from "./mls-client";

/** Comfortably longer than one operation; a process that dies holding it blocks the device this long. */
const LEASE_MS = 60_000;
const LEASE_ATTEMPTS = 20;
const LEASE_RETRY_MS = 250;
const OUTBOX = "outbox/";
const NOTE = "note/";
const HISTORY_KEY = "hk/";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One service device's store, notes and history keys over its `MlsStoreEntry`
 * rows. A note written between commits rides along with the next commit (and
 * `flush` writes what is left), so a note is never newer on disk than the
 * member state it describes.
 */
export class ServiceDeviceStore implements MlsDeviceStore, MlsHistoryKeyStore {
    readonly notes: MlsDeviceNotes;
    private readonly noted = new Map<string, string>();
    private readonly dirty = new Set<string>();
    private readonly historyKeys = new Map<string, Uint8Array>();
    private outbox: { id: number; message: Uint8Array }[] = [];
    private nextOutbox = 1;
    private snapshot: { keys: Uint8Array[]; values: Uint8Array[] } = { keys: [], values: [] };

    private constructor(readonly address: string) {
        this.notes = {
            getItem: (key) => this.noted.get(key) ?? null,
            setItem: (key, value) => {
                this.noted.set(key, value);
                this.dirty.add(key);
            }
        };
    }

    /** Read the device's rows once; `load` then hands the member its part. */
    static async open(address: string): Promise<{ store: ServiceDeviceStore; keys: Uint8Array[]; values: Uint8Array[] }> {
        const snapshot = await loadMlsStore(address);
        const store = new ServiceDeviceStore(address);
        for (const [name, value] of snapshot.reserved) {
            if (name.startsWith(NOTE)) store.noted.set(name.slice(NOTE.length), decoder.decode(value));
            else if (name.startsWith(HISTORY_KEY)) store.historyKeys.set(name.slice(HISTORY_KEY.length), value);
            else if (name.startsWith(OUTBOX)) {
                const id = Number(name.slice(OUTBOX.length));
                if (Number.isSafeInteger(id) && id > 0) store.outbox.push({ id, message: value });
            }
        }
        store.outbox.sort((a, b) => a.id - b.id);
        store.nextOutbox = (store.outbox.at(-1)?.id ?? 0) + 1;
        return { store, keys: snapshot.keys, values: snapshot.values };
    }

    /** Hand the member state read by `open` to `load` (called once, by `MlsDevice.open`). */
    hold(keys: Uint8Array[], values: Uint8Array[]): this {
        this.snapshot = { keys, values };
        return this;
    }

    async load() {
        return { ...this.snapshot, outbox: [...this.outbox] };
    }

    async commit(changes: readonly MlsStoreChange[], messages: readonly Uint8Array[] = []): Promise<number[]> {
        const ids = messages.map(() => this.nextOutbox++);
        const queued = messages.map((message, i) => ({ id: ids[i] as number, message }));
        await this.write([...changes, ...queued.map((q) => ({ key: reservedKey(`${OUTBOX}${q.id}`), value: q.message }))]);
        this.outbox.push(...queued);
        return ids;
    }

    async sent(id: number): Promise<void> {
        await this.write([{ key: reservedKey(`${OUTBOX}${id}`), value: null }]);
        this.outbox = this.outbox.filter((entry) => entry.id !== id);
    }

    /** Write the notes no commit has carried yet. */
    async flush(): Promise<void> {
        await this.write([]);
    }

    async get(channelId: string, epoch: bigint): Promise<Uint8Array | null> {
        return this.historyKeys.get(`${channelId}/${epoch}`) ?? null;
    }

    async put(channelId: string, epoch: bigint, key: Uint8Array): Promise<void> {
        const slot = `${channelId}/${epoch}`;
        // Written once: a slot already held keeps what it has.
        if (this.historyKeys.has(slot)) return;
        await this.write([{ key: reservedKey(`${HISTORY_KEY}${slot}`), value: key }]);
        this.historyKeys.set(slot, new Uint8Array(key));
    }

    /** The member's signature key note, which `MlsDevice.open` needs to restore it. */
    hasSignatureNote(device: string): boolean {
        return this.noted.has(signatureNoteKey(device));
    }

    private async write(changes: MlsStoreChange[]): Promise<void> {
        const notes = [...this.dirty].map((name) => [name, this.noted.get(name) ?? ""] as const);
        if (!changes.length && !notes.length) return;
        await commitMlsStore(this.address, [...changes, ...notes.map(([name, value]) => ({ key: reservedKey(`${NOTE}${name}`), value: encoder.encode(value) }))]);
        // A note set again while this was written stays dirty for the next write.
        for (const [name, value] of notes) if (this.noted.get(name) === value) this.dirty.delete(name);
    }
}

/** Each op through the route's own logic, as `userId`; a refusal throws `MlsRequestError` as over HTTP. */
export function inProcessTransport(userId: string): MlsTransport {
    return async (body: MlsBody) => {
        const response = await answerMls(userId, body);
        const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) throw new MlsRequestError(response.status, typeof answer.error === "string" ? answer.error : "unknown");
        return answer;
    };
}

/** Thrown when the device's lease stays held by another instance. */
export class ServiceDeviceBusy extends Error {
    constructor(readonly address: string) {
        super(`the MLS service device ${address} is held by another instance`);
        this.name = "ServiceDeviceBusy";
    }
}

/** Work queued per address in this process, so one process runs a device one operation at a time. */
const running = new Map<string, Promise<unknown>>();

let memberClass: MlsMemberClass | null = null;

export interface ServiceDeviceOptions {
    /** The `MlsMember` class; the Node binding's by default. */
    MlsMember?: MlsMemberClass;
}

/**
 * Open the service device of `owner` - the conversation id for Polar, the
 * webhook id for a webhook - register it, run `work` with it, and write what
 * it left. Serialised per device in this process and leased across processes,
 * so `work` should be MLS operations only: anything slow (a model's answer)
 * belongs before or after it, outside the lease.
 */
export async function withServiceDevice<T>(kind: ServiceKind, owner: string, work: (device: MlsDevice) => Promise<T>, options: ServiceDeviceOptions = {}): Promise<T> {
    if (!chatE2eeEnabled()) throw new Error("sealed chat is off on this instance");
    const userId = kind === "polar" ? POLAR_SERVICE_ID : WEBHOOK_SERVICE_ID;
    const device = serviceDevice(owner);
    const address = `${userId}/${device}`;
    const before = running.get(address) ?? Promise.resolve();
    const turn = before.catch(() => undefined).then(() => leased(address, () => run(userId, device, address, work, options)));
    running.set(address, turn);
    try {
        return await turn;
    } finally {
        if (running.get(address) === turn) running.delete(address);
    }
}

async function leased<T>(address: string, work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt++) {
        const result = await withLease(`mls.device.${address}`, LEASE_MS, async () => ({ value: await work() }));
        if (result) return result.value;
        await new Promise((resolve) => setTimeout(resolve, LEASE_RETRY_MS));
    }
    throw new ServiceDeviceBusy(address);
}

async function run<T>(userId: string, device: string, address: string, work: (device: MlsDevice) => Promise<T>, options: ServiceDeviceOptions): Promise<T> {
    const MlsMember = options.MlsMember ?? (memberClass ??= nativeMlsMember<MlsMemberClass>());
    let opened = await ServiceDeviceStore.open(address);
    // Member state with no signature key note cannot be restored, and a new
    // member over it would mix two members' keys: start over as a device that
    // lost its store (it rejoins, and removes its old leaf itself).
    if (opened.keys.length && !opened.store.hasSignatureNote(device)) {
        await destroyMlsStore(address);
        opened = await ServiceDeviceStore.open(address);
    }
    const { store } = opened;
    const mls = await MlsDevice.open({ userId, device, MlsMember, store: store.hold(opened.keys, opened.values), notes: store.notes, historyKeys: store, transport: inProcessTransport(userId) });
    try {
        await store.flush();
        await mls.register();
        return await work(mls);
    } finally {
        await store.flush();
    }
}
