/**
 * Shared search segments (docs/chat-e2ee-mls.md, "Shared search segments"):
 * the format, its key and its seal, pure and the same in a browser, a Worker
 * and the server's migrator. The device index (`sealed-search-index.ts`)
 * finds only what one browser opened; a segment carries the search terms of
 * a stretch of one conversation's sealed messages to every member who can
 * read those messages, sealed so that nobody else - the server included -
 * reads a term.
 *
 * Built on what every end-to-end messenger does - Signal Desktop's FTS5
 * table, WhatsApp's and Wire's local search, Element's Seshat (a tantivy
 * index encrypted on the device): the index is made and searched only where
 * the words were opened, never on the server. A segment is that index for
 * one stretch, made by one member device and handed to the others the way a
 * message is, under a key only they hold.
 *
 *     IK(c, e)  = HKDF-SHA256(HK(c, e), salt = c, info = "polaris chat index v1" || u64(e))
 *     framed    = u32(len) || deflate-raw(JSON {v, ids, terms}) || zero padding to 2^k >= 4 KiB, <= 512 KiB
 *     sealed    = AES-256-GCM(IK, nonce = random 96 bits, framed, aad = [LABEL, c, e, seq, generation])
 *     signature = Ed25519(device, CONTENT_SIGNATURE_LABEL || [SIGN_LABEL, c, e, seq, generation, SHA-256(nonce || sealed)])
 *
 * Inside: the message ids with the time of each one's last edit, and an
 * inverted index from term (`foldForSearch` tokens) to positions in that id
 * list. No words beyond the terms, no names. A search matches a term the way
 * the device index does - as one run inside the text - by scanning the
 * terms for each typed token, so it finds a superset of what the text holds,
 * and every hit is opened and checked before it is shown.
 */

import { foldForSearch } from "./sealed-search-index";

/** Messages one segment indexes at most. */
export const SEGMENT_MESSAGES = 5_000;
/** The smallest padded segment. */
export const SEGMENT_MIN_BYTES = 4 * 1024;
/** The largest padded segment: a stretch that does not fit ends earlier. */
export const SEGMENT_MAX_BYTES = 512 * 1024;
/** Corrections past this share of the base's messages make the next builder write a new base. */
export const CORRECTION_SHARE = 0.25;
/** The builder a migrated segment names (`indexMigrated`): the migration run, signed by its own key. */
export const MIGRATION_BUILDER = "migration";

const KEY_INFO = "polaris chat index v1";
const SEAL_LABEL = "polaris/chat-e2ee/index-segment/v1";
const SIGN_LABEL = "polaris/chat-e2ee/index-segment-signature/v1";
/** What the binding's `signContent` puts in front of the payload (polaris_core::mls::CONTENT_SIGNATURE_LABEL). */
const CONTENT_SIGNATURE_LABEL = new TextEncoder().encode("polaris/chat-e2ee/content-signature/v1\u0000");
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const FORMAT = 1;

/** Where a segment sits: its conversation, epoch, stretch and generation. */
export interface SegmentBinding {
    readonly channelId: string;
    readonly epoch: bigint;
    readonly seq: number;
    readonly generation: number;
}

/** One opened message, as a builder hands it in. */
export interface SegmentEntry {
    readonly id: string;
    /** Its last edit (absent if never). */
    readonly editedAt?: string;
    readonly body: string;
}

/** A segment opened: ids with their versions, and term -> positions. */
export interface SegmentIndex {
    readonly ids: ReadonlyArray<readonly [string, string]>;
    readonly terms: Readonly<Record<string, readonly number[]>>;
}

/** A message a segment names for a term, with the version it indexed. */
export interface SegmentHit {
    readonly id: string;
    readonly editedAt?: string;
}

export class SegmentTooLarge extends Error {
    constructor() {
        super("the index segment is larger than a segment may be");
        this.name = "SegmentTooLarge";
    }
}

const encoder = new TextEncoder();

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(bytes.length));
    out.set(bytes);
    return out;
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(parts.reduce((sum, part) => sum + part.length, 0)));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function u64(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, value));
    return out;
}

function checkBinding(binding: SegmentBinding): void {
    const { channelId, epoch, seq, generation } = binding;
    if (typeof channelId !== "string" || !channelId) throw new TypeError("a segment names its conversation");
    if (typeof epoch !== "bigint" || epoch < 0n) throw new TypeError("a segment's epoch is a non-negative bigint");
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(generation) || generation < 0) throw new TypeError("a segment's seq and generation are non-negative integers");
}

function aad(binding: SegmentBinding): Uint8Array<ArrayBuffer> {
    return owned(encoder.encode(JSON.stringify([SEAL_LABEL, binding.channelId, binding.epoch.toString(), binding.seq, binding.generation])));
}

/** The distinct terms of a text: runs of letters, marks and digits, folded. */
export function termsOf(text: string): string[] {
    return [...new Set(foldForSearch(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])];
}

/** The index key of one conversation's epoch, from that epoch's history key. */
export async function indexKey(historyKey: Uint8Array, channelId: string, epoch: bigint): Promise<Uint8Array> {
    if (historyKey.length !== KEY_BYTES) throw new RangeError("A history key is 32 bytes");
    const base = await crypto.subtle.importKey("raw", owned(historyKey), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: owned(encoder.encode(channelId)), info: concat(encoder.encode(KEY_INFO), u64(epoch)) },
        base,
        KEY_BYTES * 8
    );
    return new Uint8Array(bits);
}

/** The inverted index of these messages, ids in order (UUIDv7: oldest first), each once. */
export function buildIndex(entries: readonly SegmentEntry[]): SegmentIndex {
    const sorted = [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const terms: Record<string, number[]> = Object.create(null);
    sorted.forEach((entry, position) => {
        for (const term of termsOf(entry.body)) (terms[term] ??= []).push(position);
    });
    return { ids: sorted.map((entry) => [entry.id, entry.editedAt ?? ""] as const), terms };
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const out = new Response(new Blob([owned(bytes)]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
}

/** The padded size a framed body of `length` bytes takes. */
export function paddedSize(length: number): number {
    let size = SEGMENT_MIN_BYTES;
    while (size < length) size *= 2;
    return size;
}

/** Deflate and pad an index; past `SEGMENT_MAX_BYTES` it throws `SegmentTooLarge`. */
export async function encodeIndex(index: SegmentIndex): Promise<Uint8Array<ArrayBuffer>> {
    const deflated = await pipe(encoder.encode(JSON.stringify({ v: FORMAT, ids: index.ids, terms: index.terms })), new CompressionStream("deflate-raw"));
    const size = paddedSize(4 + deflated.length);
    if (size > SEGMENT_MAX_BYTES) throw new SegmentTooLarge();
    const framed = new Uint8Array(new ArrayBuffer(size));
    new DataView(framed.buffer).setUint32(0, deflated.length);
    framed.set(deflated, 4);
    return framed;
}

function isIndex(value: unknown): value is SegmentIndex & { v: number } {
    if (!value || typeof value !== "object") return false;
    const { v, ids, terms } = value as { v?: unknown; ids?: unknown; terms?: unknown };
    if (v !== FORMAT || !Array.isArray(ids) || !terms || typeof terms !== "object") return false;
    if (!ids.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")) return false;
    return Object.values(terms).every((positions) => Array.isArray(positions) && positions.every((p) => Number.isInteger(p) && p >= 0 && p < ids.length));
}

/** The index inside a framed body; null for anything this version did not write. */
export async function decodeIndex(framed: Uint8Array): Promise<SegmentIndex | null> {
    if (framed.length < 4) return null;
    const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0);
    if (length > framed.length - 4) return null;
    try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await pipe(framed.subarray(4, 4 + length), new DecompressionStream("deflate-raw"))));
        if (!isIndex(parsed)) return null;
        const terms: Record<string, readonly number[]> = Object.create(null);
        for (const [term, positions] of Object.entries(parsed.terms)) terms[term] = positions;
        return { ids: parsed.ids, terms };
    } catch {
        return null;
    }
}

/** Seal an index for its place. */
export async function sealSegment(key: Uint8Array, binding: SegmentBinding, index: SegmentIndex): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
    checkBinding(binding);
    const framed = await encodeIndex(index);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const aes = await crypto.subtle.importKey("raw", owned(key), "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(binding) }, aes, framed));
    framed.fill(0);
    return { nonce, ciphertext };
}

/** Open a segment; null when it does not open under this key for this place, or is not one this version wrote. */
export async function openSegment(key: Uint8Array, binding: SegmentBinding, nonce: Uint8Array, ciphertext: Uint8Array): Promise<SegmentIndex | null> {
    checkBinding(binding);
    if (nonce.length !== NONCE_BYTES) return null;
    try {
        const aes = await crypto.subtle.importKey("raw", owned(key), "AES-GCM", false, ["decrypt"]);
        const framed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: owned(nonce), additionalData: aad(binding) }, aes, owned(ciphertext)));
        return decodeIndex(framed);
    } catch {
        return null;
    }
}

/** What the builder's device signs (with `signContent`, which puts `CONTENT_SIGNATURE_LABEL` in front). */
export async function segmentSignaturePayload(binding: SegmentBinding, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    checkBinding(binding);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(nonce, ciphertext)));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return encoder.encode(JSON.stringify([SIGN_LABEL, binding.channelId, binding.epoch.toString(), binding.seq, binding.generation, hex]));
}

/** Whether `signature` is the device's over this segment, under its MLS signature key (Ed25519). */
export async function verifySegmentSignature(
    signaturePublicKey: Uint8Array,
    binding: SegmentBinding,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
    signature: Uint8Array
): Promise<boolean> {
    if (signaturePublicKey.length !== 32 || signature.length !== 64) return false;
    try {
        const key = await crypto.subtle.importKey("raw", owned(signaturePublicKey), { name: "Ed25519" }, false, ["verify"]);
        const signed = concat(CONTENT_SIGNATURE_LABEL, await segmentSignaturePayload(binding, nonce, ciphertext));
        return await crypto.subtle.verify({ name: "Ed25519" }, key, owned(signature), signed);
    } catch {
        return false;
    }
}

/** The messages an index names for every token of `term` (each token a run inside one of its terms). */
export function searchIndex(index: SegmentIndex, term: string): SegmentHit[] {
    const wanted = termsOf(term);
    if (!wanted.length) return [];
    const dictionary = Object.keys(index.terms);
    let found: Set<number> | null = null;
    for (const token of wanted) {
        const positions = new Set<number>();
        for (const known of dictionary) if (known.includes(token)) for (const p of index.terms[known]!) positions.add(p);
        const kept: Set<number> = found === null ? positions : new Set(Array.from(found).filter((p) => positions.has(p)));
        if (!kept.size) return [];
        found = kept;
    }
    return Array.from(found ?? []).map((p) => {
        const [id, editedAt] = index.ids[p]!;
        return editedAt ? { id, editedAt } : { id };
    });
}

/** Whether `next` (a version's last edit) is newer than `kept`. */
function newer(next: string, kept: string): boolean {
    return next > kept;
}

/**
 * Opened segments held in memory (in a Worker, or on the page where there is
 * none): per message id the entry with the newest edit time wins, across a
 * base, its corrections and an older epoch the message was edited out of.
 */
export class SegmentSearcher {
    private readonly segments = new Map<string, { channelId: string; index: SegmentIndex }>();

    /** Keep an opened segment under its place (`key` names it, so a second open replaces it). */
    add(key: string, channelId: string, index: SegmentIndex): void {
        this.segments.set(key, { channelId, index });
    }

    has(key: string): boolean {
        return this.segments.has(key);
    }

    get size(): number {
        return this.segments.size;
    }

    /** Messages whose newest indexed version holds `term`, newest first, at most `limit`. */
    search(term: string, channelId: string | null, limit: number): (SegmentHit & { readonly channelId: string })[] {
        const latest = new Map<string, string>();
        const matching = new Map<string, string>();
        const channelOf = new Map<string, string>();
        for (const segment of this.segments.values()) {
            if (channelId && segment.channelId !== channelId) continue;
            for (const [id, editedAt] of segment.index.ids) {
                const kept = latest.get(id);
                if (kept === undefined || newer(editedAt, kept)) latest.set(id, editedAt);
            }
            for (const hit of searchIndex(segment.index, term)) {
                const editedAt = hit.editedAt ?? "";
                const kept = matching.get(hit.id);
                if (kept === undefined || newer(editedAt, kept)) matching.set(hit.id, editedAt);
                channelOf.set(hit.id, segment.channelId);
            }
        }
        const out: (SegmentHit & { readonly channelId: string })[] = [];
        for (const id of [...matching.keys()].sort().reverse()) {
            const editedAt = matching.get(id)!;
            // A newer version of this message is indexed and does not hold the words.
            if (latest.get(id) !== editedAt) continue;
            const channel = channelOf.get(id)!;
            out.push(editedAt ? { id, channelId: channel, editedAt } : { id, channelId: channel });
            if (out.length >= limit) break;
        }
        return out;
    }

    clear(): void {
        this.segments.clear();
    }
}
