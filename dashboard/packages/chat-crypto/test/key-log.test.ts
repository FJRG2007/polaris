/**
 * The account key log's Merkle tree: RFC 6962 roots (the vectors every CT
 * implementation tests against, recomputed independently in Python), proofs
 * built from complete-subtree hashes alone, and RFC 9162 verifiers that accept
 * every honest proof and refuse a tampered one.
 */

import * as log from "../src/key-log";
import { describe, expect, it } from "vitest";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** RFC 6962's eight test leaves (certificate-transparency / transparency-dev merkle tests). */
const RFC_LEAVES = [
    [],
    [0x00],
    [0x10],
    [0x20, 0x21],
    [0x30, 0x31],
    [0x40, 0x41, 0x42, 0x43],
    [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57],
    [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f]
].map((bytes) => new Uint8Array(bytes));

const RFC_ROOTS: Record<number, string> = {
    1: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    2: "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    3: "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    5: "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
    7: "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
    8: "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328"
};

/** A store as the server keeps it: complete-subtree hashes, filled by `appendedNodes`. */
async function store(leaves: Uint8Array[]): Promise<log.NodeReader> {
    const nodes = new Map<string, Uint8Array>();
    const read: log.NodeReader = (level, index) => {
        const found = nodes.get(`${level}:${index}`);
        if (!found) throw new Error(`node ${level}:${index} was never stored`);
        return found;
    };
    for (const [index, data] of leaves.entries()) {
        for (const node of await log.appendedNodes(index, await log.leafHash(data), read)) nodes.set(`${node.level}:${node.index}`, node.hash);
    }
    return read;
}

const leavesOf = (count: number) => Array.from({ length: count }, (_, i) => new Uint8Array([i % 256, Math.floor(i / 256)]));

describe("key log tree", () => {
    it("computes RFC 6962's roots from stored subtrees", async () => {
        const read = await store(RFC_LEAVES);
        for (const [size, root] of Object.entries(RFC_ROOTS)) expect(hex(await log.rootOf(Number(size), read))).toBe(root);
        expect(hex(await log.rootOf(0, read))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("proves and verifies every leaf of every tree up to 33 leaves", async () => {
        const leaves = leavesOf(33);
        const read = await store(leaves);
        for (let size = 1; size <= 33; size++) {
            const root = await log.rootOf(size, read);
            for (let index = 0; index < size; index++) {
                const proof = await log.inclusionProof(index, size, read);
                const leaf = await log.leafHash(leaves[index]!);
                expect(await log.verifyInclusion(index, size, leaf, proof, root)).toBe(true);
                if (size > 1) expect(await log.verifyInclusion((index + 1) % size, size, leaf, proof, root)).toBe(false);
            }
        }
    });

    it("proves and verifies consistency between every pair of sizes up to 33", async () => {
        const read = await store(leavesOf(33));
        const roots = await Promise.all(Array.from({ length: 34 }, (_, size) => log.rootOf(size, read)));
        for (let first = 0; first <= 33; first++) {
            for (let second = first; second <= 33; second++) {
                const proof = await log.consistencyProof(first, second, read);
                expect(await log.verifyConsistency(first, second, roots[first]!, roots[second]!, proof)).toBe(true);
                if (first > 0 && first < second) {
                    // A fork: the same sizes with a different older root.
                    expect(await log.verifyConsistency(first, second, roots[second]!, roots[second]!, proof)).toBe(false);
                }
            }
        }
    });

    it("refuses a proof with a flipped bit, an extra hash or a missing one", async () => {
        const leaves = leavesOf(21);
        const read = await store(leaves);
        const root = await log.rootOf(21, read);
        const proof = await log.inclusionProof(13, 21, read);
        const leaf = await log.leafHash(leaves[13]!);
        const flipped = proof.map((p, i) => (i === 1 ? p.map((b, j) => (j === 0 ? b ^ 1 : b)) : p));
        expect(await log.verifyInclusion(13, 21, leaf, flipped, root)).toBe(false);
        expect(await log.verifyInclusion(13, 21, leaf, [...proof, proof[0]!], root)).toBe(false);
        expect(await log.verifyInclusion(13, 21, leaf, proof.slice(1), root)).toBe(false);
        expect(await log.verifyInclusion(21, 21, leaf, proof, root)).toBe(false);

        const older = await log.rootOf(9, read);
        const consistency = await log.consistencyProof(9, 21, read);
        expect(await log.verifyConsistency(9, 21, older, root, consistency.slice(0, -1))).toBe(false);
        expect(await log.verifyConsistency(9, 21, older, root, [])).toBe(false);
        expect(await log.verifyConsistency(21, 9, root, older, consistency)).toBe(false);
    });

    it("reads only a logarithmic number of stored subtrees for a proof", async () => {
        const read = await store(leavesOf(1000));
        const needed = await log.nodesNeeded((reader) => log.inclusionProof(613, 1000, reader));
        expect(needed.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(1000)));
        const both = await log.nodesNeeded(async (reader) => {
            await log.rootOf(1000, reader);
            await log.consistencyProof(377, 1000, reader);
        });
        const nodes = new Map(await Promise.all(both.map(async (c) => [`${c.level}:${c.index}`, await read(c.level, c.index)] as const)));
        const fromNeeded: log.NodeReader = (level, index) => nodes.get(`${level}:${index}`)!;
        expect(hex(await log.rootOf(1000, fromNeeded))).toBe(hex(await log.rootOf(1000, read)));
    });

    it("binds a leaf to the account, the version and both public halves", async () => {
        const entry = { userId: "0190a1b2-0000-7000-8000-000000000001", akVersion: 1, signPublicKey: new Uint8Array(32).fill(1), hpkePublicKey: new Uint8Array(1216).fill(2) };
        const base = hex(await log.entryLeafHash(entry));
        expect(hex(await log.entryLeafHash({ ...entry, akVersion: 2 }))).not.toBe(base);
        expect(hex(await log.entryLeafHash({ ...entry, userId: "0190a1b2-0000-7000-8000-000000000002" }))).not.toBe(base);
        expect(hex(await log.entryLeafHash({ ...entry, hpkePublicKey: new Uint8Array(1216).fill(3) }))).not.toBe(base);
    });

    it("verifies a signed head and refuses one whose size, root or key differ", async () => {
        const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
        const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
        const unsigned = { treeSize: 5, timestamp: 1_790_000_000_000, rootHash: new Uint8Array(32).fill(7) };
        const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, log.headMessage(unsigned) as Uint8Array<ArrayBuffer>));
        const head = { ...unsigned, signature };
        expect(await log.verifyHead(head, publicKey)).toBe(true);
        expect(await log.verifyHead({ ...head, treeSize: 6 }, publicKey)).toBe(false);
        expect(await log.verifyHead({ ...head, rootHash: new Uint8Array(32).fill(8) }, publicKey)).toBe(false);
        expect(await log.verifyHead(head, new Uint8Array(32).fill(9))).toBe(false);
    });
});

describe("key log hand-over", () => {
    const pairs = async (count: number) =>
        Promise.all(
            Array.from({ length: count }, async () => {
                const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
                return { pair, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
            })
        );
    const at = (treeSize: number) => ({ treeSize, timestamp: 1_790_000_000_000 + treeSize, rootHash: new Uint8Array(32).fill(treeSize) });
    async function handover(from: { pair: CryptoKeyPair; publicKey: Uint8Array }, to: Uint8Array, treeSize: number): Promise<log.KeyHandover> {
        const unsigned = { fromKey: from.publicKey, toKey: to, head: at(treeSize) };
        const message = log.handoverMessage(unsigned) as Uint8Array<ArrayBuffer>;
        return { ...unsigned, signature: new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, from.pair.privateKey, message)) };
    }

    it("follows a chain of signed hand-overs from the pinned key to the current one", async () => {
        const [a, b, c] = await pairs(3);
        const chain = [await handover(a!, b!.publicKey, 4), await handover(b!, c!.publicKey, 9)];
        const followed = await log.followHandovers(a!.publicKey, c!.publicKey, chain);
        expect(followed.kind).toBe("linked");
        expect(followed.kind !== "broken" && followed.links.map((l) => l.head.treeSize)).toEqual([4, 9]);
        // Links before the pinned key are history this browser never needed.
        expect((await log.followHandovers(b!.publicKey, c!.publicKey, chain)).kind).toBe("linked");
    });

    it("refuses a forged, altered or incomplete chain", async () => {
        const [a, b, c, mallory] = await pairs(4);
        const good = await handover(a!, b!.publicKey, 4);
        expect((await log.followHandovers(a!.publicKey, c!.publicKey, [good])).kind).toBe("broken");
        expect((await log.followHandovers(a!.publicKey, b!.publicKey, [await handover(mallory!, b!.publicKey, 4)])).kind).toBe("broken");
        const forged = { ...(await handover(mallory!, b!.publicKey, 4)), fromKey: a!.publicKey };
        expect((await log.followHandovers(a!.publicKey, b!.publicKey, [forged])).kind).toBe("broken");
        expect((await log.followHandovers(a!.publicKey, b!.publicKey, [{ ...good, head: at(5) }])).kind).toBe("broken");
        expect((await log.followHandovers(a!.publicKey, b!.publicKey, [{ ...good, toKey: c!.publicKey }])).kind).toBe("broken");
        expect((await log.followHandovers(a!.publicKey, b!.publicKey, [])).kind).toBe("broken");
    });

    it("tells a replacement the old key never signed apart, and never calls it linked", async () => {
        const [a, b, c] = await pairs(3);
        const reset: log.KeyHandover = { fromKey: a!.publicKey, toKey: b!.publicKey, head: at(4), signature: null };
        const followed = await log.followHandovers(a!.publicKey, c!.publicKey, [reset, await handover(b!, c!.publicKey, 9)]);
        expect(followed.kind).toBe("reset");
        expect((await log.verifyHandover(reset))).toBe(false);
    });

    it("is the same key with no chain at all", async () => {
        const [a] = await pairs(1);
        expect((await log.followHandovers(a!.publicKey, a!.publicKey, [])).kind).toBe("linked");
    });
});
