/**
 * Shared search segments on the device (docs/chat-e2ee-mls.md, "Shared
 * search segments"): building them from what this browser opened, writing a
 * correction after an edit, and searching the ones every member built, so a
 * new browser finds sealed messages it never opened.
 *
 * Building: for one conversation's epoch, stretch by stretch, the server
 * lists the sealed messages a segment may name (`index-stretch`); a stretch
 * is built only when every one of them is in this device's index at the
 * version the server holds, it is full or its epoch has ended, and the
 * route hands this device the lease. A built stretch is checked the same way
 * and rebuilt when it misses a message, or when its corrections pass a
 * quarter of it.
 *
 * Searching: the segments this account may read are listed newest first and
 * opened in a Worker (in memory only); a hit is only a candidate, opened and
 * checked against its words before it is shown (`sealed-chat.ts`).
 *
 * Neither uses a segment whose signature does not check (`signedSegment`):
 * against the key the builder's leaf holds in this device's copy of the group,
 * so the server cannot pass off one under another member's name.
 */

import * as segment from "./search-segment";
import { fromText, toText } from "./base64url";
import { LEGACY_EPOCH } from "./mls-history-keys";
import type { SearchSegmentBody } from "./mls-client";
import type { IndexedSealed } from "./sealed-search-index";

/** What this module needs of the browser's MLS device (`MlsDevice`). */
export interface SegmentDevice {
    historyKey(channelId: string, epoch: bigint): Promise<Uint8Array | null>;
    searchSegments(body: SegmentOp): Promise<Record<string, unknown>>;
    signSearchSegment(payload: Uint8Array): Uint8Array;
    currentEpoch(channelId: string): bigint | null;
    /** The key `address`'s leaf holds in this device's copy of the group; null for no leaf, undefined for no copy. */
    memberSignatureKey(channelId: string, address: string): Uint8Array | null | undefined;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SegmentOp = DistributiveOmit<SearchSegmentBody, "device">;

/** What the builder reads of this device's own index (`SealedSearchIndex`). */
export interface SegmentSource {
    loaded(): Promise<void>;
    entry(id: string): IndexedSealed | undefined;
}

/** One segment as the server lists it. */
export interface ListedSegment {
    readonly channelId: string;
    readonly epoch: string;
    readonly seq: number;
    readonly generation: number;
    readonly base: boolean;
    readonly messages: number;
    readonly lastId: string | null;
    readonly bytes: number;
    readonly createdAt: string;
}

/** Listing pages read at most per refresh (50 segments each). */
export const MAX_LIST_PAGES = 20;
/** Segments fetched at once. */
const FETCH_PARALLEL = 4;
/** Stretches one build pass looks at, at most. */
const MAX_STRETCHES = 40;

const segmentKey = (s: { channelId: string; epoch: string | bigint; seq: number; generation: number }) => `${s.channelId}/${s.epoch}/${s.seq}/${s.generation}`;

/** Every segment of one scope this account may read, newest first. */
export async function listSegments(device: SegmentDevice, scope: { channelId?: string; epoch?: bigint } = {}): Promise<ListedSegment[]> {
    const out: ListedSegment[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const answer = await device.searchSegments({
            op: "index-segments",
            ...(scope.channelId ? { channelId: scope.channelId } : {}),
            ...(scope.channelId && scope.epoch !== undefined ? { epoch: scope.epoch.toString() } : {}),
            ...(before ? { before } : {})
        });
        out.push(...((answer.segments as ListedSegment[] | undefined) ?? []));
        before = typeof answer.next === "string" ? answer.next : undefined;
        if (!before) break;
    }
    return out;
}

/** The kept generations of each stretch: its newest base and the corrections above it. */
function byStretch(listed: readonly ListedSegment[]): Map<number, { base: ListedSegment | null; corrections: ListedSegment[]; top: number }> {
    const out = new Map<number, { base: ListedSegment | null; corrections: ListedSegment[]; top: number }>();
    for (const s of listed) {
        const at = out.get(s.seq) ?? { base: null, corrections: [], top: -1 };
        at.top = Math.max(at.top, s.generation);
        if (s.base && (!at.base || s.generation > at.base.generation)) at.base = s;
        out.set(s.seq, at);
    }
    for (const [seq, at] of out) at.corrections = listed.filter((s) => s.seq === seq && !s.base && (!at.base || s.generation > at.base.generation));
    return out;
}

/** One segment as the server hands it out, its signature checked; null when it is not there or does not check. */
async function fetchSigned(device: SegmentDevice, listed: ListedSegment): Promise<{ binding: segment.SegmentBinding; nonce: Uint8Array; ciphertext: Uint8Array } | null> {
    const answer = await device.searchSegments({ op: "index-segment", channelId: listed.channelId, epoch: listed.epoch, seq: listed.seq, generation: listed.generation });
    if (typeof answer.nonce !== "string" || typeof answer.ciphertext !== "string") return null;
    const binding = { channelId: listed.channelId, epoch: BigInt(listed.epoch), seq: listed.seq, generation: listed.generation };
    const nonce = fromText(answer.nonce);
    const ciphertext = fromText(answer.ciphertext);
    return (await signedSegment(device, binding, nonce, ciphertext, answer)) ? { binding, nonce, ciphertext } : null;
}

/**
 * Whether a segment's signature is its builder's. A member device's is checked
 * against the key that member's leaf holds in this device's copy of the
 * group, which MLS authenticated: a builder with no leaf there is refused,
 * whatever key the server names. Only where this device holds no copy is the
 * key the server registered for the device taken, as for a sealed message
 * (`MlsDevice.readSealed`); the seal under the epoch's index key still means
 * only a holder of its history key made it. A migrated segment is taken only
 * in the legacy epoch, under the run's key: that epoch's history key was made
 * by the migrator, which signed its messages the same way.
 */
export async function signedSegment(
    device: SegmentDevice,
    binding: segment.SegmentBinding,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    answer: Record<string, unknown>
): Promise<boolean> {
    const { builder, signature, signatureKey } = answer;
    if (typeof builder !== "string" || typeof signature !== "string") return false;
    const named = typeof signatureKey === "string" ? fromText(signatureKey) : null;
    let key: Uint8Array | null;
    if (builder === segment.MIGRATION_BUILDER) key = binding.epoch === LEGACY_EPOCH ? named : null;
    else {
        const member = device.memberSignatureKey(binding.channelId, builder);
        key = member === undefined ? named : member;
    }
    return key !== null && segment.verifySegmentSignature(key, binding, nonce, ciphertext, fromText(signature));
}

async function openListed(device: SegmentDevice, key: Uint8Array, listed: ListedSegment): Promise<segment.SegmentIndex | null> {
    const fetched = await fetchSigned(device, listed);
    return fetched ? segment.openSegment(key, fetched.binding, fetched.nonce, fetched.ciphertext) : null;
}

/** Seal, sign and store one segment. */
async function upload(
    device: SegmentDevice,
    key: Uint8Array,
    binding: segment.SegmentBinding,
    index: segment.SegmentIndex,
    base: boolean,
    lastId: string | null
): Promise<void> {
    const { nonce, ciphertext } = await segment.sealSegment(key, binding, index);
    const signature = device.signSearchSegment(await segment.segmentSignaturePayload(binding, nonce, ciphertext));
    await device.searchSegments({
        op: "put-index-segment",
        channelId: binding.channelId,
        epoch: binding.epoch.toString(),
        seq: binding.seq,
        generation: binding.generation,
        base,
        messages: index.ids.length,
        lastId,
        nonce: toText(nonce),
        ciphertext: toText(ciphertext),
        signature: toText(signature)
    });
}

/** The longest run of `entries` from the start whose segment fits, halving until it does. */
async function fitting(entries: readonly segment.SegmentEntry[]): Promise<segment.SegmentEntry[]> {
    let count = entries.length;
    for (;;) {
        const taken = entries.slice(0, count);
        try {
            await segment.encodeIndex(segment.buildIndex(taken));
            return taken;
        } catch (caught) {
            if (!(caught instanceof segment.SegmentTooLarge) || count <= 1) throw caught;
            count = Math.ceil(count / 2);
        }
    }
}

/**
 * Build or repair this conversation's segments of one epoch from what this
 * device opened. Answers how many segments it stored.
 */
export async function buildSegments(device: SegmentDevice, source: SegmentSource, channelId: string, epoch: bigint): Promise<number> {
    const historyKey = await device.historyKey(channelId, epoch);
    if (!historyKey) return 0;
    const key = await segment.indexKey(historyKey, channelId, epoch);
    await source.loaded();
    const current = device.currentEpoch(channelId);
    const ended = current !== null && epoch < current;
    const stretches = byStretch(await listSegments(device, { channelId, epoch }));
    let built = 0;
    let after: string | null = null;
    for (let seq = 0; seq < MAX_STRETCHES; seq++) {
        const stretch = (await device.searchSegments({ op: "index-stretch", channelId, epoch: epoch.toString(), afterId: after })) as {
            messages?: { id: string; editedAt?: string }[];
            more?: boolean;
        };
        const listed = stretch.messages ?? [];
        if (!listed.length) break;
        const kept = stretches.get(seq);
        // A built stretch keeps where it ends, so the next one still starts after it.
        const covered = kept?.base?.lastId ? listed.filter((m) => m.id <= kept.base!.lastId!) : listed;
        const entries: segment.SegmentEntry[] = [];
        for (const message of covered) {
            const known = source.entry(message.id);
            if (!known || (known.editedAt ?? "") !== (message.editedAt ?? "")) return built;
            entries.push({ id: message.id, ...(message.editedAt ? { editedAt: message.editedAt } : {}), body: known.body });
        }
        if (kept?.base) {
            const corrected = kept.corrections.reduce((sum, s) => sum + s.messages, 0);
            const opened = await openListed(device, key, kept.base);
            const named = new Set(opened?.ids.map(([id]) => id) ?? []);
            const missing = !opened || covered.some((m) => !named.has(m.id));
            if (!missing && corrected <= kept.base.messages * segment.CORRECTION_SHARE) {
                after = kept.base.lastId;
                continue;
            }
        } else if (!ended && !stretch.more && listed.length < segment.SEGMENT_MESSAGES) {
            // The epoch is still being written to and this stretch is not full: later.
            break;
        }
        const taken = kept?.base ? entries : await fitting(entries);
        const lease = await device.searchSegments({ op: "claim-index-build", channelId, epoch: epoch.toString(), seq });
        if (lease.granted !== true) break;
        const lastId = kept?.base?.lastId ?? taken[taken.length - 1]!.id;
        await upload(device, key, { channelId, epoch, seq, generation: (kept?.top ?? -1) + 1 }, segment.buildIndex(taken), true, lastId);
        built += 1;
        after = lastId;
    }
    return built;
}

/**
 * After a sealed edit: put the new version in a correction segment of the
 * epoch it was sealed in, where a base already names or will name it. Nothing
 * when no segment of that stretch is built yet - its base will index it.
 */
export async function writeCorrection(device: SegmentDevice, channelId: string, epoch: bigint, entry: segment.SegmentEntry): Promise<boolean> {
    const historyKey = await device.historyKey(channelId, epoch);
    if (!historyKey) return false;
    const key = await segment.indexKey(historyKey, channelId, epoch);
    for (let attempt = 0; attempt < 2; attempt++) {
        const stretches = [...byStretch(await listSegments(device, { channelId, epoch })).entries()].sort((a, b) => a[0] - b[0]);
        const target = stretches.find(([, at]) => at.base?.lastId && entry.id <= at.base.lastId);
        if (!target) return false;
        const [seq, at] = target;
        try {
            await upload(device, key, { channelId, epoch, seq, generation: at.top + 1 }, segment.buildIndex([entry]), false, null);
            return true;
        } catch (caught) {
            // Another correction took that generation first: once more over the new listing.
            if (attempt === 1 || !(caught instanceof Error) || !/stale/.test(String((caught as { reason?: string }).reason ?? caught.message))) throw caught;
        }
    }
    return false;
}

/** What the page asks the searching Worker. */
export type SegmentWorkerRequest =
    | {
          readonly op: "add";
          readonly key: string;
          readonly binding: { readonly channelId: string; readonly epoch: string; readonly seq: number; readonly generation: number };
          readonly indexKey: Uint8Array;
          readonly nonce: Uint8Array;
          readonly ciphertext: Uint8Array;
      }
    | { readonly op: "search"; readonly term: string; readonly channelId: string | null; readonly limit: number }
    | { readonly op: "clear" };

export type SegmentCandidate = segment.SegmentHit & { readonly channelId: string };

/** Where opened segments are held and searched: a Worker, or this page where there is none. */
export interface SegmentSearchHost {
    add(request: Extract<SegmentWorkerRequest, { op: "add" }>): Promise<boolean>;
    search(term: string, channelId: string | null, limit: number): Promise<SegmentCandidate[]>;
    clear(): Promise<void>;
}

/** Segments held on this page's own thread (tests, or a browser without module Workers). */
export function pageSearchHost(): SegmentSearchHost {
    const searcher = new segment.SegmentSearcher();
    return {
        async add({ key, binding, indexKey, nonce, ciphertext }) {
            const index = await segment.openSegment(indexKey, { ...binding, epoch: BigInt(binding.epoch) }, nonce, ciphertext);
            if (index) searcher.add(key, binding.channelId, index);
            return Boolean(index);
        },
        async search(term, channelId, limit) {
            return searcher.search(term, channelId, limit);
        },
        async clear() {
            searcher.clear();
        }
    };
}

/** Segments held in a Worker. */
export function workerSearchHost(): SegmentSearchHost {
    const worker = new Worker(new URL("./search-segment-worker.ts", import.meta.url), { type: "module", name: "Sealed search" });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (caught: Error) => void }>();
    let next = 0;
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value?: unknown }>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        if (event.data.ok) entry.resolve(event.data.value);
        else entry.reject(new Error("the search segment step failed"));
    };
    worker.onerror = () => {
        for (const entry of pending.values()) entry.reject(new Error("the search Worker stopped"));
        pending.clear();
    };
    const ask = <T>(request: SegmentWorkerRequest): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const id = ++next;
            pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            worker.postMessage({ id, request });
        });
    return {
        add: (request) => ask<boolean>(request),
        search: (term, channelId, limit) => ask<SegmentCandidate[]>({ op: "search", term, channelId, limit }),
        clear: async () => {
            await ask<boolean>({ op: "clear" });
        }
    };
}

/**
 * The segments this account may read, opened as they arrive: `refresh` lists
 * them and opens each one not held yet; `search` answers from what is open.
 */
export class SegmentReader {
    private readonly held = new Set<string>();
    private readonly keys = new Map<string, Promise<Uint8Array | null>>();
    private refreshing: Promise<void> | null = null;

    constructor(
        private readonly device: SegmentDevice,
        private readonly host: SegmentSearchHost
    ) {}

    /** List and open every segment not held yet; one refresh at a time. */
    refresh(): Promise<void> {
        this.refreshing ??= this.load().finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    /** The refresh under way, if any. */
    get loading(): Promise<void> | null {
        return this.refreshing;
    }

    search(term: string, channelId: string | null, limit: number): Promise<SegmentCandidate[]> {
        return this.host.search(term, channelId, limit);
    }

    async clear(): Promise<void> {
        this.held.clear();
        this.keys.clear();
        await this.host.clear();
    }

    private indexKey(channelId: string, epoch: string): Promise<Uint8Array | null> {
        const at = `${channelId}/${epoch}`;
        let found = this.keys.get(at);
        if (!found) {
            found = this.device
                .historyKey(channelId, BigInt(epoch))
                .then((historyKey) => (historyKey ? segment.indexKey(historyKey, channelId, BigInt(epoch)) : null))
                .catch(() => null);
            this.keys.set(at, found);
        }
        return found;
    }

    private async load(): Promise<void> {
        const listed = (await listSegments(this.device)).filter((s) => !this.held.has(segmentKey(s)));
        let cursor = 0;
        const worker = async () => {
            while (cursor < listed.length) {
                const s = listed[cursor++]!;
                const key = await this.indexKey(s.channelId, s.epoch);
                if (!key) continue;
                // One the server forged or swapped is left out, as if it were not there.
                const fetched = await fetchSigned(this.device, s).catch(() => null);
                if (!fetched) continue;
                const opened = await this.host.add({
                    op: "add",
                    key: segmentKey(s),
                    binding: { channelId: s.channelId, epoch: s.epoch, seq: s.seq, generation: s.generation },
                    indexKey: key,
                    nonce: fetched.nonce,
                    ciphertext: fetched.ciphertext
                });
                if (opened) this.held.add(segmentKey(s));
            }
        };
        await Promise.all(Array.from({ length: FETCH_PARALLEL }, worker));
    }
}
