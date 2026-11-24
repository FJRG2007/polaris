/**
 * Two tabs of one browser share its MLS device: operations never overlap
 * across tabs, and a tab opens the device again from the store only when
 * another tab wrote to it since its own last operation.
 */

import { describe, expect, it } from "vitest";
import type { MlsDevice, MlsDeviceStore } from "@/lib/chat/e2ee/mls-client";
import { deviceAcrossTabs, type TabsEnvironment } from "@/lib/chat/e2ee/device-across-tabs";

/** A Web Locks stand-in: one holder per name, the rest queued in order. */
function fakeLocks(): NonNullable<TabsEnvironment["locks"]> {
    const tails = new Map<string, Promise<unknown>>();
    return {
        request: ((name: string, _options: unknown, work: () => Promise<unknown>) => {
            const before = tails.get(name) ?? Promise.resolve();
            const run = before.then(work, work);
            tails.set(name, run.catch(() => undefined));
            return run;
        }) as unknown as LockManager["request"]
    };
}

function memoryNotes(): TabsEnvironment["notes"] {
    const values = new Map<string, string>();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

function memoryStore(): MlsDeviceStore {
    return { load: async () => ({ keys: [], values: [], outbox: [] }), commit: async () => [], sent: async () => undefined };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A device whose `write` commits to the store and `read` does not; both record overlap. */
function tab(name: string, opens: string[], log: { active: number; most: number }) {
    return async (store: MlsDeviceStore) => {
        opens.push(name);
        const step = async <T>(answer: T, write: boolean) => {
            log.active += 1;
            log.most = Math.max(log.most, log.active);
            await pause();
            if (write) await store.commit([{ key: new Uint8Array([1]), value: new Uint8Array([2]) }]);
            log.active -= 1;
            return answer;
        };
        return {
            hasGroup: () => true,
            write: () => step(`${name} wrote`, true),
            read: () => step(`${name} read`, false)
        } as unknown as MlsDevice;
    };
}

type Probe = MlsDevice & { write(): Promise<string>; read(): Promise<string> };

describe("one device across tabs", () => {
    it("never runs two tabs' operations at once", async () => {
        const locks = fakeLocks(), notes = memoryNotes(), log = { active: 0, most: 0 }, opens: string[] = [];
        const one = (await deviceAcrossTabs("d", memoryStore(), tab("one", opens, log), { locks, notes })) as Probe;
        const two = (await deviceAcrossTabs("d", memoryStore(), tab("two", opens, log), { locks, notes })) as Probe;
        await Promise.all([one.write(), two.write(), one.write(), two.read()]);
        expect(log.most).toBe(1);
    });

    it("opens the store again only after another tab wrote to it", async () => {
        const locks = fakeLocks(), notes = memoryNotes(), log = { active: 0, most: 0 }, opens: string[] = [];
        const one = (await deviceAcrossTabs("d", memoryStore(), tab("one", opens, log), { locks, notes })) as Probe;
        const two = (await deviceAcrossTabs("d", memoryStore(), tab("two", opens, log), { locks, notes })) as Probe;
        expect(opens).toEqual(["one", "two"]);
        await two.read();
        await one.read();
        // Reads move nothing: neither tab opened again.
        expect(opens).toEqual(["one", "two"]);
        await one.write();
        await one.write();
        // Its own writes do not make a tab reload.
        expect(opens).toEqual(["one", "two"]);
        await two.read();
        expect(opens).toEqual(["one", "two", "two"]);
        await two.read();
        expect(opens).toEqual(["one", "two", "two"]);
    });

    it("keeps one tab's operations in turn without the Web Locks API", async () => {
        const notes = memoryNotes(), log = { active: 0, most: 0 }, opens: string[] = [];
        const one = (await deviceAcrossTabs("d", memoryStore(), tab("one", opens, log), { locks: null, notes })) as Probe;
        const answers = await Promise.all([one.write(), one.read(), one.write()]);
        expect(answers).toEqual(["one wrote", "one read", "one wrote"]);
        expect(log.most).toBe(1);
    });

    it("answers what is noted at once, and runs the first preparation under the lock", async () => {
        const locks = fakeLocks(), notes = memoryNotes(), log = { active: 0, most: 0 }, opens: string[] = [];
        const prepared: string[] = [];
        const one = (await deviceAcrossTabs("d", memoryStore(), tab("one", opens, log), { locks, notes }, async () => void prepared.push("one"))) as Probe;
        expect(one.hasGroup("c")).toBe(true);
        expect(prepared).toEqual(["one"]);
    });

    it("reads sealed messages without waiting behind another tab's operation", async () => {
        const locks = fakeLocks(), notes = memoryNotes();
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const device = (await deviceAcrossTabs("d", memoryStore(), async () => ({
            hold: () => blocked,
            readSealed: async () => ["opened"]
        }) as unknown as MlsDevice, { locks, notes })) as MlsDevice & { hold(): Promise<void> };
        const holding = device.hold();
        await expect(device.readSealed("c", ["m"])).resolves.toEqual(["opened"]);
        release();
        await holding;
    });

    it("passes a failure on and keeps serving after it", async () => {
        const locks = fakeLocks(), notes = memoryNotes();
        let fail = true;
        const device = (await deviceAcrossTabs("d", memoryStore(), async () => ({
            act: async () => {
                if (fail) throw new Error("refused");
                return "ok";
            }
        }) as unknown as MlsDevice, { locks, notes })) as MlsDevice & { act(): Promise<string> };
        await expect(device.act()).rejects.toThrow("refused");
        fail = false;
        await expect(device.act()).resolves.toBe("ok");
    });
});
