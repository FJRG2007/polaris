/**
 * A device's index of the sealed text it opened: found by its words, newest
 * first and within one conversation when asked, back after a restart, never in
 * the clear in the database, the newest version of an edit kept, and gone with
 * the device.
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { bodyMatches, SealedSearchIndex } from "@/lib/chat/e2ee/sealed-search-index";

const HERE = "0190a000-0000-7000-8000-000000000001";
const THERE = "0190a000-0000-7000-8000-000000000002";
const id = (n: number) => `0190b000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

async function rawEntries(device: string): Promise<unknown[]> {
    const request = indexedDB.open(`polaris-mls-search/${device}`);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const all = db.transaction("entries", "readonly").objectStore("entries").getAll();
    const rows = await new Promise<unknown[]>((resolve) => (all.onsuccess = () => resolve(all.result)));
    db.close();
    return rows;
}

describe("SealedSearchIndex", () => {
    it("finds opened text by its words, newest first, in one conversation when asked", async () => {
        const index = await SealedSearchIndex.open("search-a");
        await index.record({ id: id(1), channelId: HERE, body: "The launch plan is ready" });
        await index.record({ id: id(2), channelId: THERE, body: "launch PLAN moved" });
        await index.record({ id: id(3), channelId: HERE, body: "lunch?" });
        expect(await index.search("launch plan", null, 10)).toEqual([id(2), id(1)]);
        expect(await index.search("Launch Plan", HERE, 10)).toEqual([id(1)]);
        expect(await index.search("launch", null, 1)).toEqual([id(2)]);
        expect(await index.search("   ", null, 10)).toEqual([]);
        index.close();
    });

    it("keeps the text across a reopen, sealed at rest", async () => {
        const index = await SealedSearchIndex.open("search-b");
        await index.record({ id: id(1), channelId: HERE, body: "the vault code is 7741" });
        index.close();
        const again = await SealedSearchIndex.open("search-b");
        expect(await again.search("vault code", HERE, 10)).toEqual([id(1)]);
        const raw = JSON.stringify(await rawEntries("search-b"), (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value));
        expect(raw).not.toContain("vault");
        expect(raw).not.toContain(HERE);
        again.close();
        // Opened again on a later page: the version is already kept, so it is not sealed again.
        const [before] = (await rawEntries("search-b")) as { iv: Uint8Array }[];
        const later = await SealedSearchIndex.open("search-b");
        await later.record({ id: id(1), channelId: HERE, body: "the vault code is 7741" });
        const [after] = (await rawEntries("search-b")) as { iv: Uint8Array }[];
        expect(Buffer.from(after!.iv).equals(Buffer.from(before!.iv))).toBe(true);
        expect(await later.search("vault", null, 10)).toEqual([id(1)]);
        later.close();
    });

    it("keeps the newest version of an edited message, whichever order they arrive in", async () => {
        const index = await SealedSearchIndex.open("search-c");
        await index.record({ id: id(1), channelId: HERE, body: "first words" });
        await index.record({ id: id(1), channelId: HERE, editedAt: "2026-11-24T10:00:00.000Z", body: "second words" });
        await index.record({ id: id(1), channelId: HERE, body: "first words" });
        expect(await index.search("first", null, 10)).toEqual([]);
        expect(await index.search("second", null, 10)).toEqual([id(1)]);
        index.close();
        const again = await SealedSearchIndex.open("search-c");
        expect(await again.search("second", null, 10)).toEqual([id(1)]);
        again.close();
    });

    it("drops what it is told is gone, and opens nothing sealed under another key", async () => {
        const index = await SealedSearchIndex.open("search-d");
        await index.record({ id: id(1), channelId: HERE, body: "keep me" });
        await index.record({ id: id(2), channelId: HERE, body: "keep me too" });
        await index.forget([id(2)]);
        expect(await index.search("keep", null, 10)).toEqual([id(1)]);
        index.close();
        // The database copied to another browser: its key does not come along, so nothing opens.
        const elsewhere = await SealedSearchIndex.open("search-e");
        elsewhere.close();
        const [entry] = (await rawEntries("search-d")) as object[];
        const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open("polaris-mls-search/search-e");
            request.onsuccess = () => resolve(request.result);
        });
        const put = db.transaction("entries", "readwrite");
        put.objectStore("entries").put(entry, id(1));
        await new Promise((resolve) => (put.oncomplete = resolve));
        db.close();
        const reopened = await SealedSearchIndex.open("search-e");
        expect(await reopened.search("keep", null, 10)).toEqual([]);
        expect(await rawEntries("search-e")).toEqual([]);
        reopened.close();
    });

    it("is gone with the device", async () => {
        const index = await SealedSearchIndex.open("search-f");
        await index.record({ id: id(1), channelId: HERE, body: "words" });
        index.close();
        await SealedSearchIndex.destroy("search-f");
        const fresh = await SealedSearchIndex.open("search-f");
        expect(await fresh.search("words", null, 10)).toEqual([]);
        fresh.close();
    });

    it("matches the whole term as one run, case and composition folded", () => {
        expect(bodyMatches("Café au lait", "CAFÉ")).toBe(true);
        expect(bodyMatches("plan for launch", "launch plan")).toBe(false);
        expect(bodyMatches("anything", " ")).toBe(false);
    });
});
