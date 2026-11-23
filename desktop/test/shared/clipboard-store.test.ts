import { describe, expect, it } from "vitest";
import {
    boundClips,
    CLIPBOARD_KEEP,
    CLIPBOARD_MAX_ENTRIES,
    CLIPBOARD_MAX_TOTAL_CHARS,
    ClipboardStore,
    clipboardOn,
    type ClipboardCipher,
    type ClipboardFile
} from "@/shared/clipboard-store";

const WEEK = CLIPBOARD_KEEP.week;
const NOW = 1_800_000_000_000;

/** A stand-in key store: reversible, and visibly not plain text. */
function cipher(available = true): ClipboardCipher {
    return {
        available: () => available,
        encrypt: (text) => new TextEncoder().encode(`enc:${Buffer.from(text).toString("base64")}`),
        decrypt: (data) => {
            const text = new TextDecoder().decode(data);
            if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
            return Buffer.from(text.slice(4), "base64").toString();
        }
    };
}

function memoryFile(initial: Uint8Array | null = null): ClipboardFile & { data: Uint8Array | null; writes: number; } {
    const file = {
        data: initial,
        writes: 0,
        read: () => file.data,
        write: (data: Uint8Array) => {
            file.data = data;
            file.writes += 1;
        },
        remove: () => {
            file.data = null;
        }
    };
    return file;
}

describe("the clipboard history on disk", () => {
    it("never writes plain text, and keeps memory only without a key store", () => {
        const file = memoryFile();
        const store = new ClipboardStore(cipher(false), file);
        expect(store.persists()).toBe(false);
        const kept = store.save([{ text: "secret-ish", at: NOW }], NOW, WEEK);
        expect(kept).toHaveLength(1);
        expect(file.writes).toBe(0);
        expect(store.load(NOW, WEEK)).toEqual([]);
    });

    it("writes encrypted and reads back what it wrote", () => {
        const file = memoryFile();
        const store = new ClipboardStore(cipher(), file);
        store.save([{ text: "hello", at: NOW }], NOW, WEEK);
        expect(new TextDecoder().decode(file.data!)).not.toContain("hello");
        expect(store.load(NOW + 1000, WEEK)).toEqual([{ text: "hello", at: NOW }]);
    });

    it("prunes what is older than the chosen time on load and on add", () => {
        const file = memoryFile();
        const store = new ClipboardStore(cipher(), file);
        const old = { text: "old", at: NOW - WEEK - 1 };
        const fresh = { text: "fresh", at: NOW - 1000 };
        expect(store.save([fresh, old], NOW, WEEK)).toEqual([fresh]);
        expect(store.load(NOW + 1000, CLIPBOARD_KEEP.day)).toEqual([fresh]);
        expect(store.load(NOW + CLIPBOARD_KEEP.day * 2, CLIPBOARD_KEEP.day)).toEqual([]);
    });

    it("stays within the entry and byte bounds, newest first", () => {
        const many = Array.from({ length: CLIPBOARD_MAX_ENTRIES + 50 }, (_, at) => ({ text: `copy ${at}`, at: NOW - at }));
        const kept = boundClips(many, NOW, WEEK);
        expect(kept).toHaveLength(CLIPBOARD_MAX_ENTRIES);
        expect(kept[0]?.text).toBe("copy 0");
        const big = Array.from({ length: 200 }, (_, at) => ({ text: "x".repeat(20_000), at: NOW - at }));
        const total = boundClips(big, NOW, WEEK).reduce((sum, entry) => sum + entry.text.length, 0);
        expect(total).toBeLessThanOrEqual(CLIPBOARD_MAX_TOTAL_CHARS);
        expect(boundClips([{ text: "y".repeat(20_001), at: NOW }], NOW, WEEK)).toEqual([]);
    });

    it("discards a corrupt or undecryptable file instead of failing on it", () => {
        const garbage = memoryFile(new TextEncoder().encode("not ours"));
        expect(new ClipboardStore(cipher(), garbage).load(NOW, WEEK)).toEqual([]);
        expect(garbage.data).toBeNull();
        const badJson = memoryFile(new TextEncoder().encode(`enc:${Buffer.from("{oops").toString("base64")}`));
        expect(new ClipboardStore(cipher(), badJson).load(NOW, WEEK)).toEqual([]);
        expect(badJson.data).toBeNull();
        const throwing: ClipboardFile = { read: () => { throw new Error("EACCES"); }, write: () => { throw new Error("EROFS"); }, remove: () => { throw new Error("EBUSY"); } };
        const store = new ClipboardStore(cipher(), throwing);
        expect(store.load(NOW, WEEK)).toEqual([]);
        expect(store.save([{ text: "a", at: NOW }], NOW, WEEK)).toHaveLength(1);
        expect(() => store.clear()).not.toThrow();
    });

    it("deletes the file on clear (which is what turning it off does)", () => {
        const file = memoryFile();
        const store = new ClipboardStore(cipher(), file);
        store.save([{ text: "a", at: NOW }], NOW, WEEK);
        expect(file.data).not.toBeNull();
        store.clear();
        expect(file.data).toBeNull();
    });
});

describe("the clipboard history's default", () => {
    it("is on for an install that never chose, and keeps a choice made since", () => {
        // Older files carry `false` for everyone who saved any setting.
        expect(clipboardOn(false, false)).toBe(true);
        expect(clipboardOn(true, false)).toBe(true);
        expect(clipboardOn(false, true)).toBe(false);
        expect(clipboardOn(true, true)).toBe(true);
    });
});
