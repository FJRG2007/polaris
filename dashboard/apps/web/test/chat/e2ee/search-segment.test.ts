/**
 * The shared search segment format (docs/chat-e2ee-mls.md, "Shared search
 * segments"): its key, seal, padding, signature and search, and the phase-0
 * measurement the design asked for before building.
 */

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import * as segment from "@/lib/chat/e2ee/search-segment";

const channelId = "0192f5a0-0000-7000-8000-000000000001";
const binding = { channelId, epoch: 3n, seq: 0, generation: 0 };
const historyKey = new Uint8Array(32).fill(7);
const id = (n: number) => `0192f5a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const CONTENT_SIGNATURE_LABEL = new TextEncoder().encode("polaris/chat-e2ee/content-signature/v1\u0000");

describe("index key", () => {
    it("is one per conversation and epoch, from that epoch's history key", async () => {
        const a = await segment.indexKey(historyKey, channelId, 3n);
        expect(a).toHaveLength(32);
        expect(await segment.indexKey(historyKey, channelId, 3n)).toEqual(a);
        expect(await segment.indexKey(historyKey, channelId, 4n)).not.toEqual(a);
        expect(await segment.indexKey(historyKey, id(2), 3n)).not.toEqual(a);
        expect(await segment.indexKey(new Uint8Array(32).fill(8), channelId, 3n)).not.toEqual(a);
        await expect(segment.indexKey(new Uint8Array(16), channelId, 3n)).rejects.toThrow(RangeError);
    });
});

describe("seal and open", () => {
    const entries = [
        { id: id(1), body: "Meet at the Café Ñandú tomorrow" },
        { id: id(2), editedAt: "2026-11-27T10:00:00.000Z", body: "The budget for Q3 is ready" },
        { id: id(3), body: "東京で会いましょう" }
    ];

    it("opens to the ids, versions and terms it was built from, and nothing beyond", async () => {
        const key = await segment.indexKey(historyKey, channelId, 3n);
        const index = segment.buildIndex(entries);
        const { nonce, ciphertext } = await segment.sealSegment(key, binding, index);
        const opened = await segment.openSegment(key, binding, nonce, ciphertext);
        expect(opened?.ids).toEqual([
            [id(1), ""],
            [id(2), "2026-11-27T10:00:00.000Z"],
            [id(3), ""]
        ]);
        expect(Object.keys(opened!.terms)).toContain("ñandú");
        expect(new TextDecoder().decode(ciphertext)).not.toContain("budget");
    });

    it("opens to nothing for another place, key or a changed byte", async () => {
        const key = await segment.indexKey(historyKey, channelId, 3n);
        const { nonce, ciphertext } = await segment.sealSegment(key, binding, segment.buildIndex(entries));
        expect(await segment.openSegment(key, { ...binding, generation: 1 }, nonce, ciphertext)).toBeNull();
        expect(await segment.openSegment(key, { ...binding, seq: 1 }, nonce, ciphertext)).toBeNull();
        expect(await segment.openSegment(key, { ...binding, epoch: 4n }, nonce, ciphertext)).toBeNull();
        expect(await segment.openSegment(await segment.indexKey(historyKey, channelId, 4n), binding, nonce, ciphertext)).toBeNull();
        const changed = new Uint8Array(ciphertext);
        changed[10] ^= 1;
        expect(await segment.openSegment(key, binding, nonce, changed)).toBeNull();
    });

    it("pads to a power of two from 4 KiB, so its size says little more than the count", async () => {
        const key = await segment.indexKey(historyKey, channelId, 3n);
        const small = await segment.sealSegment(key, binding, segment.buildIndex(entries.slice(0, 1)));
        const three = await segment.sealSegment(key, binding, segment.buildIndex(entries));
        expect(small.ciphertext.length).toBe(4096 + 16);
        expect(three.ciphertext.length).toBe(4096 + 16);
        expect(segment.paddedSize(4097)).toBe(8192);
    });

    it("refuses an index past 512 KiB", async () => {
        const huge = Array.from({ length: 3000 }, (_, n) => ({ id: id(n + 1), body: crypto.getRandomValues(new Uint8Array(150)).reduce((t, b) => t + b.toString(36), "") }));
        await expect(segment.encodeIndex(segment.buildIndex([...huge, ...huge.map((e, n) => ({ ...e, id: id(n + 5000) }))]))).rejects.toThrow(segment.SegmentTooLarge);
    });
});

describe("signature", () => {
    it("is the builder device's, over this segment in this place", async () => {
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
        const key = await segment.indexKey(historyKey, channelId, 3n);
        const { nonce, ciphertext } = await segment.sealSegment(key, binding, segment.buildIndex([{ id: id(1), body: "hello" }]));
        const payload = await segment.segmentSignaturePayload(binding, nonce, ciphertext);
        const signature = new Uint8Array(sign(null, Buffer.concat([CONTENT_SIGNATURE_LABEL, payload]), privateKey));
        expect(await segment.verifySegmentSignature(raw, binding, nonce, ciphertext, signature)).toBe(true);
        expect(await segment.verifySegmentSignature(raw, { ...binding, generation: 1 }, nonce, ciphertext, signature)).toBe(false);
        const other = new Uint8Array(ciphertext);
        other[0] ^= 1;
        expect(await segment.verifySegmentSignature(raw, binding, nonce, other, signature)).toBe(false);
        // A message signature never passes as a segment's: the payload is labelled.
        expect(await segment.verifySegmentSignature(raw, binding, nonce, ciphertext, new Uint8Array(sign(null, Buffer.concat([CONTENT_SIGNATURE_LABEL, ciphertext]), privateKey)))).toBe(false);
    });
});

describe("search", () => {
    const index = segment.buildIndex([
        { id: id(1), body: "Quarterly budget review on Friday" },
        { id: id(2), body: "budgeting tips" },
        { id: id(3), body: "Friday lunch?" },
        { id: id(4), body: "Reunión con el CAFÉ" }
    ]);

    it("matches a run inside a term, every typed word, case and composition folded", () => {
        expect(segment.searchIndex(index, "budget").map((h) => h.id)).toEqual([id(1), id(2)]);
        expect(segment.searchIndex(index, "budget friday").map((h) => h.id)).toEqual([id(1)]);
        expect(segment.searchIndex(index, "FRI").map((h) => h.id).sort()).toEqual([id(1), id(3)]);
        expect(segment.searchIndex(index, "café").map((h) => h.id)).toEqual([id(4)]);
        expect(segment.searchIndex(index, "nothing here")).toEqual([]);
        expect(segment.searchIndex(index, "  ")).toEqual([]);
    });

    it("finds every message whose text holds the term as one run (a superset, checked once opened)", () => {
        const bodies = ["a-b c", "ab c", "xa b", "a.b"];
        const built = segment.buildIndex(bodies.map((body, n) => ({ id: id(n + 1), body })));
        for (const term of ["a-b", "a b", "b c", "a.b"]) {
            const found = new Set(segment.searchIndex(built, term).map((h) => h.id));
            bodies.forEach((body, n) => {
                if (body.includes(term)) expect(found.has(id(n + 1))).toBe(true);
            });
        }
    });

    it("keeps, per message, the newest indexed version across segments", () => {
        const searcher = new segment.SegmentSearcher();
        searcher.add("base", channelId, segment.buildIndex([{ id: id(1), body: "old words" }, { id: id(2), body: "old too" }]));
        searcher.add("fix", channelId, segment.buildIndex([{ id: id(1), editedAt: "2026-11-27T10:00:00.000Z", body: "new words" }]));
        searcher.add("elsewhere", id(99), segment.buildIndex([{ id: id(3), body: "old elsewhere" }]));
        expect(searcher.search("old", null, 10).map((h) => h.id)).toEqual([id(3), id(2)]);
        expect(searcher.search("new", null, 10)).toEqual([{ id: id(1), channelId, editedAt: "2026-11-27T10:00:00.000Z" }]);
        expect(searcher.search("old", channelId, 10).map((h) => h.id)).toEqual([id(2)]);
        expect(searcher.search("old", null, 1)).toHaveLength(1);
    });
});

describe("phase 0: what a segment costs", () => {
    // A vocabulary with a long tail, as chat text has: 150-byte messages of common and rare words.
    const vocabulary = Array.from({ length: 20_000 }, (_, n) => `w${(n * 2654435761 % 4294967296).toString(36)}`);
    const pick = (seed: number) => vocabulary[Math.floor(vocabulary.length * Math.pow((seed % 9973) / 9973, 3))]!;
    const message = (n: number) => {
        let text = "";
        for (let k = 0; text.length < 150; k++) text += `${pick(n * 31 + k * 7919)} `;
        return text.slice(0, 150);
    };

    it("builds 5,000 messages of 150 bytes into one segment, and opens and searches it fast", async () => {
        const entries = Array.from({ length: 5_000 }, (_, n) => ({ id: id(n + 1), body: message(n) }));
        const key = await segment.indexKey(historyKey, channelId, 3n);
        const started = performance.now();
        const index = segment.buildIndex(entries);
        const { nonce, ciphertext } = await segment.sealSegment(key, binding, index);
        const built = performance.now() - started;
        const opening = performance.now();
        const opened = await segment.openSegment(key, binding, nonce, ciphertext);
        const searcher = new segment.SegmentSearcher();
        searcher.add("s", channelId, opened!);
        const hits = searcher.search(entries[1234]!.body.split(" ")[0]!, null, 200);
        const openedIn = performance.now() - opening;
        const line = `phase 0: 5,000 x 150 B -> ${ciphertext.length} bytes sealed, built in ${built.toFixed(0)} ms, opened and searched in ${openedIn.toFixed(0)} ms`;
        // The numbers the doc quotes, written where `POLARIS_SEGMENT_MEASURE` names a file.
        if (process.env.POLARIS_SEGMENT_MEASURE) writeFileSync(process.env.POLARIS_SEGMENT_MEASURE, `${line}
`);
        expect(ciphertext.length).toBeLessThanOrEqual(segment.SEGMENT_MAX_BYTES + 16);
        expect(hits.map((h) => h.id)).toContain(id(1235));
    });
});
