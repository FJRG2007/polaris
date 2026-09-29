import { describe, expect, it } from "vitest";
import * as stash from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash";
import type { InventoryItem } from "@polaris-app/game-servers/src/lib/minecraft/inventory";

const item = (slot: number, id: string, snbt: string | null = null): InventoryItem => ({
    slot,
    id,
    count: 1,
    data: snbt ? { era: "components", snbt } : null
});

describe("keeping a player's things", () => {
    it("lays the 41 slots over two barrels, the hotbar first and the offhand last", () => {
        expect(stash.SLOTS).toHaveLength(41);
        expect(stash.keptAt(0)).toEqual({ barrel: 0, container: 0 });
        expect(stash.keptAt(26)).toEqual({ barrel: 0, container: 26 });
        expect(stash.keptAt(27)).toEqual({ barrel: 1, container: 0 });
        expect(stash.keptAt(103)).toEqual({ barrel: 1, container: 12 });
        expect(stash.keptAt(-106)).toEqual({ barrel: 1, container: 13 });
        // A modded slot is none of it.
        expect(stash.keptAt(150)).toBeNull();
    });

    it("never keeps the event's own kit, nor a slot vanilla does not have", () => {
        const kept = stash.keepable([
            item(0, "minecraft:diamond_sword", '{"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}}'),
            item(1, "minecraft:stone_sword", '{"minecraft:custom_data": {polaris_event: 1b}}'),
            item(150, "curios:ring")
        ]);
        expect(kept.map((one) => one.slot)).toEqual([0]);
    });

    it("puts each stash under the floor, apart from the next, and cases it in barrier", () => {
        const spots = stash.spotsUnder({ x1: 0, z1: 0, x2: 12, z2: 8, y: 100 });
        expect(spots[0]).toEqual({ x: 1, y: 99, z: 1 });
        const taken = new Set<string>();
        for (const spot of spots) {
            const blocks = stash.blocksAt(spot);
            for (const one of [...blocks.barrels, ...blocks.casing]) {
                const key = `${one.x} ${one.y} ${one.z}`;
                expect(taken.has(key)).toBe(false);
                taken.add(key);
                // Inside the floor's own columns, under it.
                expect(one.x).toBeGreaterThanOrEqual(0);
                expect(one.x).toBeLessThanOrEqual(12);
                expect(one.z).toBeGreaterThanOrEqual(0);
                expect(one.z).toBeLessThanOrEqual(8);
                expect(one.y).toBeLessThan(100);
            }
        }
        expect(stash.placeLines(stash.blocksAt(spots[0]!))[0]).toBe(
            "execute in minecraft:overworld run setblock 1 99 1 minecraft:barrel keep"
        );
    });

    it("takes a block away only while it is still the one put there", () => {
        expect(stash.removeLines({ barrels: [{ x: 1, y: 2, z: 3 }], casing: [{ x: 0, y: 2, z: 3 }] })).toEqual([
            "execute in minecraft:overworld if block 1 2 3 minecraft:barrel run setblock 1 2 3 minecraft:air",
            "execute in minecraft:overworld if block 0 2 3 minecraft:barrier run setblock 0 2 3 minecraft:air"
        ]);
    });

    it("checks a copy stack by stack, and refuses one with anything extra in a barrel", () => {
        const digest = (one: InventoryItem) => one.data?.snbt ?? null;
        const bag = [item(0, "minecraft:bow", "{a}"), item(30, "minecraft:bread")];
        const kept = stash.keepFrom(bag, digest);
        const inFirst = [{ ...bag[0]!, slot: 0 }];
        const inSecond = [{ ...bag[1]!, slot: 3 }];
        expect(stash.copiedWhole(kept, [inFirst, inSecond], digest)).toBe(true);
        expect(stash.copiedWhole(kept, [inFirst, [...inSecond, item(4, "minecraft:dirt")]], digest)).toBe(false);
        expect(stash.copiedWhole(kept, [[{ ...bag[0]!, slot: 0, data: null }], inSecond], digest)).toBe(false);
    });
});
