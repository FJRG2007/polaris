/**
 * Writing a stack back out.
 *
 * Every case here is about the same thing: `/item replace` rebuilds the stack
 * from what the argument says, so anything the argument leaves out is destroyed.
 * The refusals matter more than the successes.
 */

import { describe, expect, it } from "vitest";
import type { InventoryItem } from "@/lib/apps/minecraft/inventory";
import { AIR, isMovable, itemArgument, replaceSlot, writableSlots } from "@/lib/apps/minecraft/item-argument";

function stack(overrides: Partial<InventoryItem> = {}): InventoryItem {
    return { slot: 0, id: "minecraft:stone", count: 1, data: null, ...overrides };
}

describe("itemArgument", () => {
    it("writes a plain stack as its id", () => {
        expect(itemArgument(stack())).toEqual({ ok: true, value: "minecraft:stone" });
    });

    it("turns a componentised reply into component syntax", () => {
        // The reply quotes its keys and separates with a colon; the argument does
        // neither. The values cross over untouched.
        const item = stack({
            id: "minecraft:diamond_sword",
            data: { era: "components", snbt: '{"minecraft:damage": 5, "minecraft:unbreakable": {}}' }
        });
        expect(itemArgument(item)).toEqual({
            ok: true,
            value: "minecraft:diamond_sword[minecraft:damage=5,minecraft:unbreakable={}]"
        });
    });

    it("hands an older server its tag compound back verbatim", () => {
        const item = stack({
            id: "minecraft:diamond_sword",
            data: { era: "tag", snbt: '{Enchantments: [{id: "minecraft:sharpness", lvl: 5s}]}' }
        });
        expect(itemArgument(item)).toEqual({
            ok: true,
            value: 'minecraft:diamond_sword{Enchantments: [{id: "minecraft:sharpness", lvl: 5s}]}'
        });
    });

    it("keeps a nested compound whole rather than splitting inside it", () => {
        const item = stack({
            id: "minecraft:shulker_box",
            data: {
                era: "components",
                snbt: '{"minecraft:container": [{slot: 0, item: {id: "minecraft:tnt", count: 64}}]}'
            }
        });
        const built = itemArgument(item);
        expect(built.ok).toBe(true);
        expect(built.ok && built.value).toContain('minecraft:container=[{slot: 0, item: {id: "minecraft:tnt"');
    });

    it("writes an empty component set as an empty bracket pair", () => {
        expect(itemArgument(stack({ data: { era: "components", snbt: "{}" } }))).toEqual({
            ok: true,
            value: "minecraft:stone[]"
        });
    });

    it("refuses an unquoted key, which would split inside the namespace", () => {
        // The trap this exists for: read `minecraft:damage` unquoted and the first
        // colon found is the one inside the key, so it becomes `minecraft=damage` -
        // a component nobody asked for, in place of the one that was there.
        const item = stack({ data: { era: "components", snbt: "{minecraft:damage: 5}" } });
        expect(itemArgument(item)).toEqual({ ok: false, why: "unreadable" });
    });

    it("refuses a field with no value at all", () => {
        const item = stack({ data: { era: "components", snbt: '{"minecraft:damage"}' } });
        expect(itemArgument(item)).toEqual({ ok: false, why: "unreadable" });
    });

    it("refuses a stack whose argument would not fit down the wire", () => {
        const long = `{"minecraft:lore": ["${"x".repeat(600)}"]}`;
        expect(itemArgument(stack({ data: { era: "components", snbt: long } }))).toEqual({
            ok: false,
            why: "too-long"
        });
    });

    it("refuses a stack with no id at all", () => {
        expect(itemArgument(stack({ id: "  " })).ok).toBe(false);
    });

    it("is what isMovable answers with", () => {
        expect(isMovable(stack())).toBe(true);
        expect(isMovable(stack({ data: { era: "components", snbt: "{broken}" } }))).toBe(false);
    });
});

describe("replaceSlot", () => {
    it("maps the hotbar, the bag, the armour and the offhand", () => {
        expect(replaceSlot(0)).toBe("hotbar.0");
        expect(replaceSlot(8)).toBe("hotbar.8");
        // The bag is 9-35 in the reply and starts again at zero in the command.
        expect(replaceSlot(9)).toBe("inventory.0");
        expect(replaceSlot(35)).toBe("inventory.26");
        expect(replaceSlot(103)).toBe("armor.head");
        expect(replaceSlot(102)).toBe("armor.chest");
        expect(replaceSlot(101)).toBe("armor.legs");
        expect(replaceSlot(100)).toBe("armor.feet");
        expect(replaceSlot(-106)).toBe("weapon.offhand");
    });

    it("names every slot the grid draws, and no other", () => {
        for (const slot of writableSlots()) expect(replaceSlot(slot)).not.toBeNull();
        // A modded backpack has a name only that mod knows.
        expect(replaceSlot(200)).toBeNull();
        expect(replaceSlot(-1)).toBeNull();
        expect(replaceSlot(104)).toBeNull();
    });
});

describe("air", () => {
    it("is what empties a slot", () => {
        expect(AIR).toBe("minecraft:air");
    });
});
