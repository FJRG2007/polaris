/**
 * The account key log (design 4.6): an append-only Merkle tree of every
 * account key version the server has published, in the shape of Certificate
 * Transparency (RFC 6962, revised as RFC 9162 section 2.1). The server signs
 * each tree head; a browser trusts a published key only once it holds an
 * inclusion proof of that key under a signed head, and a consistency proof
 * from the last head it saw - so the server cannot show one browser a key it
 * hides from the account it belongs to without either forking the log (which
 * the account's own browser, checking consistency with what it saw, notices
 * when the forks meet) or leaving the substitute in the log for the account's
 * own devices to find (`monitor` in the web client).
 *
 * Hashing is RFC 6962's exactly: SHA-256, a 0x00 prefix on a leaf and 0x01 on
 * an interior node, the left subtree always the largest power of two. The
 * verifiers are RFC 9162's algorithms (2.1.3.2 and 2.1.4.2) line for line.
 *
 * Proofs are built from the hashes of complete subtrees only (`NodeReader`),
 * which is what the server stores: any root or proof needs O(log n) of them,
 * so nothing ever reads the whole log. `nodesNeeded` lists which, so the
 * server reads them all in one query before computing.
 */

import { canonical, concat, owned } from "./bytes";

const LEAF_LABEL = "polaris/chat-e2ee/key-log/v1/leaf";
const HEAD_LABEL = "polaris/chat-e2ee/key-log/v1/head";

/** A hash in the tree: 32 bytes of SHA-256. */
export const HASH_BYTES = 32;

/** The hash of the complete subtree of `2^level` leaves starting at leaf `index * 2^level`. */
export type NodeReader = (level: number, index: number) => Uint8Array | Promise<Uint8Array>;

/** One published account key version: what a leaf commits to. */
export interface KeyLogEntry {
    readonly userId: string;
    readonly akVersion: number;
    readonly signPublicKey: Uint8Array;
    readonly hpkePublicKey: Uint8Array;
}

/** A signed tree head: the log's size and root at a moment, signed by the log's key. */
export interface TreeHead {
    readonly treeSize: number;
    /** Milliseconds since the epoch, when the head was signed. */
    readonly timestamp: number;
    readonly rootHash: Uint8Array;
    /** Ed25519 over `headMessage`. */
    readonly signature: Uint8Array;
}

async function sha256(...parts: ReadonlyArray<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", owned(concat(...parts))));
}

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** RFC 6962 MTH of one leaf: SHA-256(0x00 || data). */
export function leafHash(data: Uint8Array): Promise<Uint8Array> {
    return sha256(LEAF_PREFIX, data);
}

/** RFC 6962 interior node: SHA-256(0x01 || left || right). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
    return sha256(NODE_PREFIX, left, right);
}

/** The bytes a leaf commits to: label, account, version and both public halves, unambiguously. */
export function entryBytes(entry: KeyLogEntry): Uint8Array {
    return canonical(LEAF_LABEL, entry.userId, entry.akVersion, entry.signPublicKey, entry.hpkePublicKey);
}

export function entryLeafHash(entry: KeyLogEntry): Promise<Uint8Array> {
    return leafHash(entryBytes(entry));
}

/** What a tree head's signature covers. The timestamp is decimal text: it does not fit 32 bits. */
export function headMessage(head: Pick<TreeHead, "treeSize" | "timestamp" | "rootHash">): Uint8Array {
    if (!Number.isSafeInteger(head.timestamp) || head.timestamp < 0) throw new RangeError("A head's timestamp is a whole number of ms");
    return canonical(HEAD_LABEL, head.treeSize, String(head.timestamp), head.rootHash);
}

/** Whether `head` carries a valid signature by the log key `publicKey` (raw Ed25519, 32 bytes). */
export async function verifyHead(head: TreeHead, publicKey: Uint8Array): Promise<boolean> {
    if (publicKey.length !== 32 || head.signature.length !== 64 || head.rootHash.length !== HASH_BYTES) return false;
    try {
        const key = await crypto.subtle.importKey("raw", owned(publicKey), { name: "Ed25519" }, false, ["verify"]);
        return await crypto.subtle.verify({ name: "Ed25519" }, key, owned(head.signature), owned(headMessage(head)));
    } catch {
        return false;
    }
}

/** Exact for every safe integer: `Math.log2` of a power of two is exact. */
const isPowerOfTwo = (n: number) => n > 0 && Number.isInteger(Math.log2(n));

/** The largest power of two smaller than `n` (n > 1): RFC 6962's split point. */
export function splitPoint(n: number): number {
    let k = 1;
    while (k * 2 < n) k *= 2;
    return k;
}

/** MTH(D[start:end]) from complete-subtree hashes. */
async function rangeHash(start: number, end: number, read: NodeReader): Promise<Uint8Array> {
    const size = end - start;
    if (size === 0) return sha256();
    if (isPowerOfTwo(size) && start % size === 0) return read(Math.log2(size), start / size);
    const k = splitPoint(size);
    return nodeHash(await rangeHash(start, start + k, read), await rangeHash(start + k, end, read));
}

function checkSize(...sizes: number[]): void {
    for (const size of sizes) if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("A tree size is a whole number");
}

/** The root of the first `treeSize` leaves. */
export function rootOf(treeSize: number, read: NodeReader): Promise<Uint8Array> {
    checkSize(treeSize);
    return rangeHash(0, treeSize, read);
}

/** RFC 6962 PATH(index, D[start:end]), leaf to root. */
async function path(index: number, start: number, end: number, read: NodeReader): Promise<Uint8Array[]> {
    const size = end - start;
    if (size <= 1) return [];
    const k = splitPoint(size);
    if (index < k) return [...(await path(index, start, start + k, read)), await rangeHash(start + k, end, read)];
    return [...(await path(index - k, start + k, end, read)), await rangeHash(start, start + k, read)];
}

/** The audit path of leaf `index` in the tree of `treeSize` leaves. */
export function inclusionProof(index: number, treeSize: number, read: NodeReader): Promise<Uint8Array[]> {
    checkSize(index, treeSize);
    if (index >= treeSize) throw new RangeError("The leaf is outside the tree");
    return path(index, 0, treeSize, read);
}

/** RFC 6962 SUBPROOF(m, D[start:end], b). */
async function subproof(m: number, start: number, end: number, whole: boolean, read: NodeReader): Promise<Uint8Array[]> {
    const size = end - start;
    if (m === size) return whole ? [] : [await rangeHash(start, end, read)];
    const k = splitPoint(size);
    if (m <= k) return [...(await subproof(m, start, start + k, whole, read)), await rangeHash(start + k, end, read)];
    return [...(await subproof(m - k, start + k, end, false, read)), await rangeHash(start, start + k, read)];
}

/** The proof that the tree of `first` leaves is a prefix of the tree of `second`. */
export function consistencyProof(first: number, second: number, read: NodeReader): Promise<Uint8Array[]> {
    checkSize(first, second);
    if (first > second) throw new RangeError("The first tree is larger than the second");
    if (first === 0 || first === second) return Promise.resolve([]);
    return subproof(first, 0, second, true, read);
}

/**
 * The complete-subtree hashes appending leaf `index` (with `hash`) completes:
 * the leaf itself at level 0, then each node whose last leaf it is. `read`
 * is asked only for nodes that already exist (the left siblings).
 */
export async function appendedNodes(
    index: number,
    hash: Uint8Array,
    read: NodeReader
): Promise<Array<{ level: number; index: number; hash: Uint8Array }>> {
    checkSize(index);
    const out = [{ level: 0, index, hash }];
    let current = hash;
    let position = index;
    for (let level = 1; position % 2 === 1; level++) {
        current = await nodeHash(await read(level - 1, position - 1), current);
        position = (position - 1) / 2;
        out.push({ level, index: position, hash: current });
    }
    return out;
}

/** The complete-subtree coordinates `run` reads, so a store can fetch them in one go. */
export async function nodesNeeded(run: (read: NodeReader) => Promise<unknown>): Promise<Array<{ level: number; index: number }>> {
    const seen = new Map<string, { level: number; index: number }>();
    const placeholder = new Uint8Array(HASH_BYTES);
    await run((level, index) => {
        seen.set(`${level}:${index}`, { level, index });
        return placeholder;
    });
    return [...seen.values()];
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const odd = (n: number) => n % 2 === 1;
const half = (n: number) => Math.floor(n / 2);

/** RFC 9162 2.1.3.2: whether `proof` places the leaf hash at `index` under `rootHash`. */
export async function verifyInclusion(
    index: number,
    treeSize: number,
    leaf: Uint8Array,
    proof: ReadonlyArray<Uint8Array>,
    rootHash: Uint8Array
): Promise<boolean> {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0 || index >= treeSize) return false;
    if (proof.some((p) => p.length !== HASH_BYTES)) return false;
    let fn = index;
    let sn = treeSize - 1;
    let r = leaf;
    for (const p of proof) {
        if (sn === 0) return false;
        if (odd(fn) || fn === sn) {
            r = await nodeHash(p, r);
            while (!odd(fn) && fn !== 0) {
                fn = half(fn);
                sn = half(sn);
            }
        } else {
            r = await nodeHash(r, p);
        }
        fn = half(fn);
        sn = half(sn);
    }
    return sn === 0 && same(r, rootHash);
}

/** RFC 9162 2.1.4.2: whether `proof` shows the tree (`first`, `firstRoot`) is a prefix of (`second`, `secondRoot`). */
export async function verifyConsistency(
    first: number,
    second: number,
    firstRoot: Uint8Array,
    secondRoot: Uint8Array,
    proof: ReadonlyArray<Uint8Array>
): Promise<boolean> {
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 0 || first > second) return false;
    if (proof.some((p) => p.length !== HASH_BYTES)) return false;
    if (first === second) return proof.length === 0 && same(firstRoot, secondRoot);
    if (first === 0) return proof.length === 0;
    if (proof.length === 0) return false;
    const nodes = isPowerOfTwo(first) ? [firstRoot, ...proof] : [...proof];
    let fn = first - 1;
    let sn = second - 1;
    while (odd(fn)) {
        fn = half(fn);
        sn = half(sn);
    }
    let fr = nodes[0]!;
    let sr = nodes[0]!;
    for (const c of nodes.slice(1)) {
        if (sn === 0) return false;
        if (odd(fn) || fn === sn) {
            fr = await nodeHash(c, fr);
            sr = await nodeHash(c, sr);
            while (!odd(fn) && fn !== 0) {
                fn = half(fn);
                sn = half(sn);
            }
        } else {
            sr = await nodeHash(sr, c);
        }
        fn = half(fn);
        sn = half(sn);
    }
    return same(fr, firstRoot) && same(sr, secondRoot) && sn === 0;
}

const HANDOVER_LABEL = "polaris/chat-e2ee/key-log/v1/handover";

/**
 * One change of the log's signing key: the old key signs the new one together
 * with the head the log had when it changed, so a browser that pinned the old
 * key can move to the new one on the old key's word alone (the way a CT log's
 * operator would announce a key rollover, here made checkable). `signature`
 * is null when the old key was gone - the server could no longer read it -
 * and the change is only the server's claim: a reset, never followed silently.
 */
export interface KeyHandover {
    /** Raw Ed25519 public keys, 32 bytes each. */
    readonly fromKey: Uint8Array;
    readonly toKey: Uint8Array;
    readonly head: Pick<TreeHead, "treeSize" | "timestamp" | "rootHash">;
    readonly signature: Uint8Array | null;
}

/** What a hand-over's signature covers: both keys and the head at the change. */
export function handoverMessage(handover: Pick<KeyHandover, "fromKey" | "toKey" | "head">): Uint8Array {
    const { head } = handover;
    if (!Number.isSafeInteger(head.timestamp) || head.timestamp < 0) throw new RangeError("A head's timestamp is a whole number of ms");
    return canonical(HANDOVER_LABEL, handover.fromKey, handover.toKey, head.treeSize, String(head.timestamp), head.rootHash);
}

/** Whether `handover` carries a valid signature by its own `fromKey`; false for a reset. */
export async function verifyHandover(handover: KeyHandover): Promise<boolean> {
    const { fromKey, toKey, head, signature } = handover;
    if (!signature || fromKey.length !== 32 || toKey.length !== 32 || signature.length !== 64 || head.rootHash.length !== HASH_BYTES) return false;
    try {
        const key = await crypto.subtle.importKey("raw", owned(fromKey), { name: "Ed25519" }, false, ["verify"]);
        return await crypto.subtle.verify({ name: "Ed25519" }, key, owned(signature), owned(handoverMessage(handover)));
    } catch {
        return false;
    }
}

export type HandoverChain =
    /** Every step signed by the key before it. `links` are the steps taken, oldest first. */
    | { readonly kind: "linked"; readonly links: ReadonlyArray<KeyHandover> }
    /** It reaches the current key, but at least one step was a reset the old key never signed. */
    | { readonly kind: "reset"; readonly links: ReadonlyArray<KeyHandover> }
    /** It does not reach the current key from the pinned one, or a signature does not hold. */
    | { readonly kind: "broken" };

/**
 * Walks `chain` (oldest first, as the server lists it) from the key this
 * browser pinned to the key the log signs with now. Steps before the pinned
 * key are skipped; from it on, each step must start at the key the one before
 * ended on and carry that key's signature (or none at all: a reset). The
 * heads of the steps taken are returned so the caller can check each one is a
 * prefix of the current tree - a hand-over to a forked log is still a fork.
 */
export async function followHandovers(pinned: Uint8Array, current: Uint8Array, chain: ReadonlyArray<KeyHandover>): Promise<HandoverChain> {
    if (same(pinned, current)) return { kind: "linked", links: [] };
    const start = chain.findIndex((link) => same(link.fromKey, pinned));
    if (start < 0) return { kind: "broken" };
    let key = pinned;
    let reset = false;
    const links: KeyHandover[] = [];
    for (const link of chain.slice(start)) {
        if (!same(link.fromKey, key)) return { kind: "broken" };
        if (link.signature === null) reset = true;
        else if (!(await verifyHandover(link))) return { kind: "broken" };
        links.push(link);
        key = link.toKey;
    }
    if (!same(key, current)) return { kind: "broken" };
    return reset ? { kind: "reset", links } : { kind: "linked", links };
}
