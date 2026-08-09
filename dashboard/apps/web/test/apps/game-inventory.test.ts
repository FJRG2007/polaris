import { describe, expect, it } from "vitest";
import { isDataReply, isMissingEntityReply } from "@/lib/apps/minecraft/snbt";
import {
    ARMOUR_SLOTS,
    HOTBAR_SLOTS,
    MAIN_SLOT_ROWS,
    OFFHAND_SLOT,
    bySlot,
    extraSlots,
    parseInventory,
    slotLabel
} from "@/lib/apps/minecraft/inventory";

describe("parseInventory", () => {
    it("reads the slot, the id and the count of every stack", () => {
        const reply = [
            'Alice has the following entity data: [{Slot: 0b, id: "minecraft:diamond_pickaxe", Count: 1b},',
            '{Slot: 1b, id: "minecraft:cobblestone", Count: 64b}]'
        ].join(" ");
        expect(parseInventory(reply)).toEqual([
            { slot: 0, id: "minecraft:diamond_pickaxe", count: 1, data: null },
            { slot: 1, id: "minecraft:cobblestone", count: 64, data: null }
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
        const [book] = parseInventory(reply);
        expect(book?.id).toBe("minecraft:enchanted_book");
        expect(book?.count).toBe(1);
        // The components are kept whole rather than read: they are handed back to
        // the server unchanged, and understanding them is how they get destroyed.
        expect(book?.data?.era).toBe("components");
        expect(book?.data?.snbt).toContain("minecraft:stored_enchantments");
    });

    it("reads the componentised shape, where a single item names no count", () => {
        const reply = 'Bob has the following entity data: [{slot: 3, id: "minecraft:shield"}]';
        expect(parseInventory(reply)).toEqual([{ slot: 3, id: "minecraft:shield", count: 1, data: null }]);
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

    it("reads the bag past anything the client printed before the reply", () => {
        // What comes back from the container is the command's output and its
        // diagnostics together. Taking the first bracket takes "[WARN]" and reports
        // a full inventory as an empty one.
        const reply = [
            "2026/08/08 21:45:30 [WARN] connection reset, retrying",
            'Alice has the following entity data: [{Slot: 0b, id: "minecraft:stone", Count: 64b}]'
        ].join("\n");
        expect(parseInventory(reply)).toEqual([{ slot: 0, id: "minecraft:stone", count: 64, data: null }]);
    });

    it("keeps the older shape's tag compound, and says which era wrote it", () => {
        // A server before the componentised items still answers, and its data has
        // to be written back with braces rather than brackets.
        const reply = [
            'Bob has the following entity data: [{Slot: 0b, id: "minecraft:diamond_sword", Count: 1b,',
            "tag: {Enchantments: [{id: \"minecraft:sharpness\", lvl: 5s}]}}]"
        ].join(" ");
        const [sword] = parseInventory(reply);
        expect(sword?.data?.era).toBe("tag");
        expect(sword?.data?.snbt.startsWith("{")).toBe(true);
        expect(sword?.data?.snbt).toContain("Enchantments");
    });

    it("keeps nothing from a field that arrived truncated", () => {
        // Half a compound is not a shorter compound, and handing it back would
        // write a command the server refuses - or worse, one it accepts.
        const reply = 'Bob has the following entity data: [{Slot: 0b, id: "minecraft:stone", Count: 1b, components: {broken]';
        expect(parseInventory(reply)).toEqual([]);
    });

    it("skips a bracket that holds no stack and keeps looking", () => {
        const reply = 'Alice has the following entity data: [] [{Slot: 2b, id: "minecraft:torch", Count: 3b}]';
        expect(parseInventory(reply)).toEqual([{ slot: 2, id: "minecraft:torch", count: 3, data: null }]);
    });
});

describe("telling a refusal apart from an answer", () => {
    it("recognizes the server saying the player is not there", () => {
        // The ordinary case for a bag: asked about somebody who logged off. It has
        // to be said in those words, not quoted back as if something broke.
        expect(isMissingEntityReply("No entity was found")).toBe(true);
        expect(isMissingEntityReply("No player was found")).toBe(true);
        // The plural is "entities", not "entitys" - the shape a naive pattern gets
        // wrong, and the reply a selector that matched nobody actually returns.
        expect(isMissingEntityReply("No entities were found")).toBe(true);
        expect(isMissingEntityReply("No players were found")).toBe(true);
    });

    it("does not mistake a real answer, or another failure, for it", () => {
        const reply = 'Alice has the following entity data: [{Slot: 0b, id: "minecraft:stone", Count: 1b}]';
        expect(isMissingEntityReply(reply)).toBe(false);
        expect(isDataReply(reply)).toBe(true);
        // A different refusal keeps being reported as itself.
        expect(isMissingEntityReply("Unknown or incomplete command")).toBe(false);
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

describe("the drawn layout", () => {
    it("is the game's own: nine on the hotbar, three rows of nine above it", () => {
        expect(HOTBAR_SLOTS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        expect(MAIN_SLOT_ROWS).toHaveLength(3);
        expect(MAIN_SLOT_ROWS.flat()).toHaveLength(27);
        expect(MAIN_SLOT_ROWS.flat()[0]).toBe(9);
        expect(MAIN_SLOT_ROWS.flat().at(-1)).toBe(35);
    });

    it("wears armour head first, which is the order it is drawn in", () => {
        expect(ARMOUR_SLOTS.map(slotLabel)).toEqual(["Helmet", "Chestplate", "Leggings", "Boots"]);
        expect(slotLabel(OFFHAND_SLOT)).toBe("Offhand");
    });
});

describe("extraSlots", () => {
    it("is empty when every stack has a slot the grid draws", () => {
        const items = [
            { slot: 0, id: "minecraft:stone", count: 1, data: null },
            { slot: 35, id: "minecraft:apple", count: 3, data: null },
            { slot: -106, id: "minecraft:shield", count: 1, data: null },
            { slot: 103, id: "minecraft:diamond_helmet", count: 1, data: null }
        ];
        expect(extraSlots(items)).toEqual([]);
    });

    it("keeps what a modded slot holds, rather than reporting a full bag as empty", () => {
        const backpack = { slot: 200, id: "curios:ring", count: 1, data: null };
        expect(extraSlots([{ slot: 0, id: "minecraft:stone", count: 1, data: null }, backpack])).toEqual([
            backpack
        ]);
    });
});

describe("bySlot", () => {
    it("indexes the stacks the way a grid asks for them", () => {
        const apple = { slot: 4, id: "minecraft:apple", count: 2, data: null };
        const index = bySlot([apple]);
        expect(index.get(4)).toEqual(apple);
        expect(index.get(5)).toBeUndefined();
    });
});
