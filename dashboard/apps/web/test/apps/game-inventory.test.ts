import { describe, expect, it } from "vitest";
import { parseInventory, slotLabel } from "@/lib/apps/minecraft/inventory";

describe("parseInventory", () => {
    it("reads the slot, the id and the count of every stack", () => {
        const reply = [
            'Alice has the following entity data: [{Slot: 0b, id: "minecraft:diamond_pickaxe", Count: 1b},',
            '{Slot: 1b, id: "minecraft:cobblestone", Count: 64b}]'
        ].join(" ");
        expect(parseInventory(reply)).toEqual([
            { slot: 0, id: "minecraft:diamond_pickaxe", count: 1 },
            { slot: 1, id: "minecraft:cobblestone", count: 64 }
        ]);
    });

    it("takes the stack's own id, not one buried in its components", () => {
        // An enchanted book carries an "id" per enchantment. A reader matching on
        // the word would take the first of those and report the wrong item.
        const reply = [
            'Bob has the following entity data: [{Slot: 0b, id: "minecraft:enchanted_book", Count: 1b,',
            'components: {"minecraft:stored_enchantments": {levels: {"minecraft:sharpness": 5},',
            'id: "minecraft:sharpness"}}}]'
        ].join(" ");
        expect(parseInventory(reply)).toEqual([{ slot: 0, id: "minecraft:enchanted_book", count: 1 }]);
    });

    it("reads the componentised shape, where a single item names no count", () => {
        const reply = 'Bob has the following entity data: [{slot: 3, id: "minecraft:shield"}]';
        expect(parseInventory(reply)).toEqual([{ slot: 3, id: "minecraft:shield", count: 1 }]);
    });

    it("puts the stacks in slot order however the server listed them", () => {
        const reply = [
            'A has the following entity data: [{Slot: 103b, id: "minecraft:iron_helmet", Count: 1b},',
            '{Slot: 0b, id: "minecraft:stone", Count: 1b}]'
        ].join(" ");
        expect(parseInventory(reply).map((item) => item.slot)).toEqual([0, 103]);
    });

    it("has nothing to report for an empty inventory or a refusal", () => {
        expect(parseInventory("Alice has the following entity data: []")).toEqual([]);
        expect(parseInventory("No entity was found")).toEqual([]);
        expect(parseInventory("")).toEqual([]);
    });

    it("does not invent items from a reply that was cut off", () => {
        expect(parseInventory('A has: [{Slot: 0b, id: "minecraft:stone", Count: 1b}')).toEqual([]);
    });
});

describe("slotLabel", () => {
    it("names the places a player actually thinks in", () => {
        expect(slotLabel(0)).toBe("Hotbar 1");
        expect(slotLabel(8)).toBe("Hotbar 9");
        expect(slotLabel(103)).toBe("Helmet");
        expect(slotLabel(100)).toBe("Boots");
        expect(slotLabel(-106)).toBe("Offhand");
        expect(slotLabel(27)).toBe("Slot 27");
    });
});
