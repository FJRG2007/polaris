/**
 * A device's kept history keys: back after a restart, never in the clear in
 * the database, one key per slot, and gone with the device.
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbHistoryKeyStore } from "@/lib/chat/e2ee/mls-history-keys";

const CHANNEL = "0190a000-0000-7000-8000-000000000001";
const key = (fill: number) => new Uint8Array(32).fill(fill);

async function rawRecords(device: string): Promise<unknown[]> {
    const request = indexedDB.open(`polaris-mls-history/${device}`);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const all = db.transaction("keys", "readonly").objectStore("keys").getAll();
    const rows = await new Promise<unknown[]>((resolve) => (all.onsuccess = () => resolve(all.result)));
    db.close();
    return rows;
}

describe("IndexedDbHistoryKeyStore", () => {
    it("keeps a history key across a reopen, sealed at rest", async () => {
        const store = await IndexedDbHistoryKeyStore.open("device-a");
        await store.put(CHANNEL, 3n, key(7));
        store.close();
        const again = await IndexedDbHistoryKeyStore.open("device-a");
        expect(await again.get(CHANNEL, 3n)).toEqual(key(7));
        expect(await again.get(CHANNEL, 4n)).toBeNull();
        expect(await again.get("another-channel", 3n)).toBeNull();
        const [sealed] = (await rawRecords("device-a")) as Uint8Array[];
        expect(sealed).toHaveLength(48);
        expect(Buffer.from(sealed).includes(Buffer.from(key(7)))).toBe(false);
        again.close();
    });

    it("writes a slot once: a second key for the same epoch is dropped", async () => {
        const store = await IndexedDbHistoryKeyStore.open("device-b");
        await store.put(CHANNEL, 1n, key(1));
        await store.put(CHANNEL, 1n, key(2));
        expect(await store.get(CHANNEL, 1n)).toEqual(key(1));
        await expect(store.put(CHANNEL, 2n, new Uint8Array(16))).rejects.toThrow(RangeError);
        store.close();
    });

    it("opens nothing of another device's database, and forgets the device on destroy", async () => {
        const a = await IndexedDbHistoryKeyStore.open("device-c");
        await a.put(CHANNEL, 1n, key(9));
        a.close();
        const other = await IndexedDbHistoryKeyStore.open("device-d");
        expect(await other.get(CHANNEL, 1n)).toBeNull();
        other.close();
        await IndexedDbHistoryKeyStore.destroy("device-c");
        const fresh = await IndexedDbHistoryKeyStore.open("device-c");
        expect(await fresh.get(CHANNEL, 1n)).toBeNull();
        fresh.close();
    });
});
