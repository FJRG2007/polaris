/**
 * Enchanting a stack: which enchantments are offered, which sets are accepted,
 * and how a stack is written with a new set in each of the three shapes a server
 * can take. The writes matter most - an edit must change the one field and
 * leave everything else on the stack exactly as it came.
 */

import { describe, expect, it } from "vitest";
import { itemDetails } from "@polaris-app/game-servers/src/lib/minecraft/item-details";
import { parseQueuedPayload } from "@polaris-app/game-servers/src/lib/minecraft/queue";
import { itemArgument } from "@polaris-app/game-servers/src/lib/minecraft/item-argument";
import type { InventoryItem } from "@polaris-app/game-servers/src/lib/minecraft/inventory";
import { versionAtLeast } from "@polaris-app/game-servers/src/lib/minecraft/version-compare";
import {
    availableEnchantments,
    enchantFormatFor,
    enchantedStack,
    enchantmentSetSchema,
    exceedsMax,
    itemKind,
    offeredEnchantments,
    withEnchantments
} from "@polaris-app/game-servers/src/lib/minecraft/enchantments";

function stack(overrides: Partial<InventoryItem> = {}): InventoryItem {
    return { slot: 0, id: "minecraft:diamond_sword", count: 1, data: null, ...overrides };
}

const SHARPNESS_5 = [{ id: "minecraft:sharpness", level: 5 }];

describe("enchantFormatFor", () => {
    it.each([
        ["1.21.10", "map"],
        ["1.21.5", "map"],
        ["1.21.4", "levels"],
        ["1.20.6", "levels"],
        ["1.20.5", "levels"],
        ["1.20.4", "tag"],
        ["1.16.5", "tag"],
        ["1.13", "tag"],
        ["1.12.2", null]
    ])("%s writes %s", (version, format) => {
        expect(enchantFormatFor(version, versionAtLeast)).toBe(format);
    });
});

describe("withEnchantments on 1.21.5 and later (map)", () => {
    it("adds the component to a plain item", () => {
        const out = withEnchantments(stack(), SHARPNESS_5, "map");
        expect(out?.data).toEqual({
            era: "components",
            snbt: '{"minecraft:enchantments":{"minecraft:sharpness":5}}'
        });
        expect(itemArgument(out!)).toEqual({
            ok: true,
            value: 'minecraft:diamond_sword[minecraft:enchantments={"minecraft:sharpness":5}]'
        });
    });

    it("replaces only the enchantments and keeps every other component", () => {
        const item = stack({
            data: {
                era: "components",
                snbt: '{"minecraft:damage": 12, "minecraft:enchantments": {"minecraft:smite": 3}, "minecraft:custom_name": {text:"Edge"}}'
            }
        });
        const out = withEnchantments(
            item,
            [
                { id: "minecraft:sharpness", level: 4 },
                { id: "minecraft:unbreaking", level: 3 }
            ],
            "map"
        )!;
        expect(out.data?.snbt).toBe(
            '{"minecraft:damage": 12,"minecraft:enchantments":{"minecraft:sharpness":4,"minecraft:unbreaking":3},"minecraft:custom_name": {text:"Edge"}}'
        );
        const details = itemDetails(out.data);
        expect(details.damage).toBe(12);
        expect(details.name).toBe("Edge");
        expect(details.enchantments).toEqual([
            { id: "minecraft:sharpness", level: 4 },
            { id: "minecraft:unbreaking", level: 3 }
        ]);
        expect(out.count).toBe(1);
        expect(out.slot).toBe(0);
    });

    it("removes the component when the set is empty", () => {
        const item = stack({
            data: {
                era: "components",
                snbt: '{"minecraft:damage": 2, "minecraft:enchantments": {"minecraft:smite": 3}}'
            }
        });
        expect(withEnchantments(item, [], "map")?.data?.snbt).toBe('{"minecraft:damage": 2}');
    });

    it("leaves no data at all when the enchantments were all it had", () => {
        const item = stack({
            data: { era: "components", snbt: '{"minecraft:enchantments": {"minecraft:smite": 3}}' }
        });
        expect(withEnchantments(item, [], "map")?.data).toBeNull();
    });

    it("keeps a mod's enchantment that stays in the set", () => {
        const item = stack({
            data: {
                era: "components",
                snbt: '{"minecraft:enchantments": {"minecraft:smite": 3, "somemod:lifesteal": 2}}'
            }
        });
        const out = withEnchantments(item, [{ id: "somemod:lifesteal", level: 4 }], "map");
        expect(out?.data?.snbt).toBe('{"minecraft:enchantments":{"somemod:lifesteal":4}}');
    });

    it("refuses a field it cannot read back whole", () => {
        const item = stack({
            data: {
                era: "components",
                snbt: '{"minecraft:enchantments": {"minecraft:smite": {odd: 1}}}'
            }
        });
        expect(withEnchantments(item, SHARPNESS_5, "map")).toBeNull();
    });

    it("refuses a stack whose enchantments were taken off its defaults", () => {
        const item = stack({
            data: { era: "components", snbt: '{"!minecraft:enchantments": {}}' }
        });
        expect(withEnchantments(item, SHARPNESS_5, "map")).toBeNull();
    });

    it("edits what a book carries, not what is on it", () => {
        const book = stack({
            id: "minecraft:enchanted_book",
            data: {
                era: "components",
                snbt: '{"minecraft:stored_enchantments": {"minecraft:mending": 1}}'
            }
        });
        const out = withEnchantments(
            book,
            [
                { id: "minecraft:mending", level: 1 },
                { id: "minecraft:sharpness", level: 5 }
            ],
            "map"
        )!;
        expect(out.data?.snbt).toBe(
            '{"minecraft:stored_enchantments":{"minecraft:mending":1,"minecraft:sharpness":5}}'
        );
        expect(itemDetails(out.data).stored).toHaveLength(2);
        expect(itemDetails(out.data).enchantments).toHaveLength(0);
    });
});

describe("withEnchantments on 1.20.5 to 1.21.4 (levels)", () => {
    it("wraps a new set in levels", () => {
        const out = withEnchantments(stack(), SHARPNESS_5, "levels")!;
        expect(out.data?.snbt).toBe(
            '{"minecraft:enchantments":{levels:{"minecraft:sharpness":5}}}'
        );
        expect(itemArgument(out)).toEqual({
            ok: true,
            value: 'minecraft:diamond_sword[minecraft:enchantments={levels:{"minecraft:sharpness":5}}]'
        });
    });

    it("keeps show_in_tooltip beside the levels", () => {
        const item = stack({
            data: {
                era: "components",
                snbt: '{"minecraft:enchantments": {levels: {"minecraft:smite": 2}, show_in_tooltip: 0b}}'
            }
        });
        const out = withEnchantments(item, SHARPNESS_5, "levels")!;
        expect(out.data?.snbt).toBe(
            '{"minecraft:enchantments":{levels:{"minecraft:sharpness":5},show_in_tooltip: 0b}}'
        );
        expect(itemDetails(out.data).enchantments).toEqual(SHARPNESS_5);
    });

    it("writes the shape already on the stack, whatever the format says", () => {
        const item = stack({
            data: {
                era: "components",
                snbt: '{"minecraft:enchantments": {levels: {"minecraft:smite": 2}}}'
            }
        });
        expect(withEnchantments(item, SHARPNESS_5, "map")?.data?.snbt).toBe(
            '{"minecraft:enchantments":{levels:{"minecraft:sharpness":5}}}'
        );
    });
});

describe("withEnchantments before 1.20.5 (tag)", () => {
    it("writes the old list on a plain item", () => {
        const out = withEnchantments(stack(), SHARPNESS_5, "tag")!;
        expect(out.data).toEqual({
            era: "tag",
            snbt: '{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]}'
        });
        expect(itemArgument(out)).toEqual({
            ok: true,
            value: 'minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]}'
        });
    });

    it("keeps the name and the wear", () => {
        const item = stack({
            data: {
                era: "tag",
                snbt: '{Damage: 7, display: {Name: \'{"text":"Edge"}\'}, Enchantments: [{id: "minecraft:smite", lvl: 2s}]}'
            }
        });
        const out = withEnchantments(item, [{ id: "minecraft:looting", level: 3 }], "tag")!;
        expect(out.data?.snbt).toBe(
            '{Damage: 7,display: {Name: \'{"text":"Edge"}\'},Enchantments:[{id:"minecraft:looting",lvl:3s}]}'
        );
        const details = itemDetails(out.data);
        expect(details.name).toBe("Edge");
        expect(details.damage).toBe(7);
        expect(details.enchantments).toEqual([{ id: "minecraft:looting", level: 3 }]);
    });

    it("spells sweeping edge the way these versions knew it", () => {
        const out = withEnchantments(stack(), [{ id: "minecraft:sweeping_edge", level: 3 }], "tag");
        expect(out?.data?.snbt).toBe('{Enchantments:[{id:"minecraft:sweeping",lvl:3s}]}');
        const modern = withEnchantments(stack(), [{ id: "minecraft:sweeping", level: 3 }], "map");
        expect(modern?.data?.snbt).toBe('{"minecraft:enchantments":{"minecraft:sweeping_edge":3}}');
    });

    it("writes a book's as StoredEnchantments", () => {
        const out = withEnchantments(
            stack({ id: "minecraft:enchanted_book" }),
            [{ id: "minecraft:mending", level: 1 }],
            "tag"
        );
        expect(out?.data?.snbt).toBe('{StoredEnchantments:[{id:"minecraft:mending",lvl:1s}]}');
    });

    it("removes the list when the set is empty", () => {
        const item = stack({
            data: {
                era: "tag",
                snbt: '{Damage: 1, Enchantments: [{id: "minecraft:smite", lvl: 2s}]}'
            }
        });
        expect(withEnchantments(item, [], "tag")?.data?.snbt).toBe("{Damage: 1}");
    });

    it("refuses the numeric ids from before 1.13", () => {
        const item = stack({ data: { era: "tag", snbt: "{ench: [{id: 16s, lvl: 5s}]}" } });
        expect(withEnchantments(item, SHARPNESS_5, "tag")).toBeNull();
    });

    it("refuses a list entry carrying more than an id and a level", () => {
        const item = stack({
            data: {
                era: "tag",
                snbt: '{Enchantments: [{id: "minecraft:smite", lvl: 2s, extra: 1b}]}'
            }
        });
        expect(withEnchantments(item, SHARPNESS_5, "tag")).toBeNull();
    });

    it("refuses to mix shapes", () => {
        const tagged = stack({ data: { era: "tag", snbt: "{Damage: 1}" } });
        expect(withEnchantments(tagged, SHARPNESS_5, "map")).toBeNull();
        const components = stack({ data: { era: "components", snbt: '{"minecraft:damage": 1}' } });
        expect(withEnchantments(components, SHARPNESS_5, "tag")).toBeNull();
    });
});

describe("enchantedStack, for a give", () => {
    it.each([
        ["map", 'minecraft:bow[minecraft:enchantments={"minecraft:power":5}]'],
        ["levels", 'minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":5}}]'],
        ["tag", 'minecraft:bow{Enchantments:[{id:"minecraft:power",lvl:5s}]}']
    ] as const)("%s", (format, argument) => {
        const out = enchantedStack("minecraft:bow", [{ id: "minecraft:power", level: 5 }], format);
        expect(itemArgument(out!)).toEqual({ ok: true, value: argument });
    });
});

describe("what is offered", () => {
    it("reads what an item is from its name, a mod's too", () => {
        expect(itemKind("minecraft:netherite_boots")).toBe("boots");
        expect(itemKind("somemod:ruby_sword")).toBe("sword");
        expect(itemKind("minecraft:bow")).toBe("bow");
        expect(itemKind("minecraft:stone")).toBeNull();
    });

    it("offers what fits the item and not what clashes", () => {
        const ids = offeredEnchantments("minecraft:diamond_sword", SHARPNESS_5, null).map(
            (info) => info.id
        );
        expect(ids).toContain("minecraft:looting");
        expect(ids).toContain("minecraft:mending");
        expect(ids).not.toContain("minecraft:sharpness");
        expect(ids).not.toContain("minecraft:smite");
        expect(ids).not.toContain("minecraft:power");
    });

    it("keeps loyalty and channeling together but apart from riptide", () => {
        const withLoyalty = offeredEnchantments(
            "minecraft:trident",
            [{ id: "minecraft:loyalty", level: 3 }],
            null
        ).map((info) => info.id);
        expect(withLoyalty).toContain("minecraft:channeling");
        expect(withLoyalty).not.toContain("minecraft:riptide");
    });

    it("offers a book everything, and nothing for an item that takes none", () => {
        expect(offeredEnchantments("minecraft:enchanted_book", [], null).length).toBeGreaterThan(
            30
        );
        expect(offeredEnchantments("minecraft:stone", [], null)).toEqual([]);
        expect(offeredEnchantments("minecraft:stone", [], null, true).length).toBeGreaterThan(30);
    });

    it("offers only what the server has", () => {
        const old = availableEnchantments("1.20.4", "tag", versionAtLeast);
        expect(old).not.toContain("minecraft:density");
        expect(old).toContain("minecraft:swift_sneak");
        expect(availableEnchantments("1.18.2", "tag", versionAtLeast)).not.toContain(
            "minecraft:swift_sneak"
        );
        expect(availableEnchantments("1.21.4", "levels", versionAtLeast)).toContain(
            "minecraft:density"
        );
        // No version: a tag server is still known to be older than 1.20.5.
        expect(availableEnchantments(null, "tag", versionAtLeast)).not.toContain(
            "minecraft:wind_burst"
        );
        const offered = offeredEnchantments("minecraft:mace", [], old).map((info) => info.id);
        expect(offered).not.toContain("minecraft:breach");
    });
});

describe("enchantmentSetSchema", () => {
    it("normalises ids", () => {
        const parsed = enchantmentSetSchema.parse({
            enchantments: [{ id: " Sharpness ", level: 5 }]
        });
        expect(parsed).toEqual({ enchantments: SHARPNESS_5, overMax: false });
    });

    it("holds a level past the maximum to the switch", () => {
        const set = { enchantments: [{ id: "minecraft:sharpness", level: 10 }] };
        expect(enchantmentSetSchema.safeParse(set).success).toBe(false);
        expect(enchantmentSetSchema.safeParse({ ...set, overMax: true }).success).toBe(true);
        expect(exceedsMax(set.enchantments)).toBe(true);
    });

    it("refuses past what a command takes, even with the switch", () => {
        const set = { enchantments: [{ id: "minecraft:sharpness", level: 256 }], overMax: true };
        expect(enchantmentSetSchema.safeParse(set).success).toBe(false);
        expect(
            enchantmentSetSchema.safeParse({
                enchantments: [{ id: "minecraft:sharpness", level: 0 }]
            }).success
        ).toBe(false);
    });

    it("lets a mod's enchantment go up to the command's ceiling", () => {
        expect(
            enchantmentSetSchema.safeParse({
                enchantments: [{ id: "somemod:lifesteal", level: 200 }]
            }).success
        ).toBe(true);
    });

    it("refuses one enchantment twice, in either spelling", () => {
        const set = {
            enchantments: [
                { id: "minecraft:sweeping", level: 1 },
                { id: "minecraft:sweeping_edge", level: 2 }
            ]
        };
        expect(enchantmentSetSchema.safeParse(set).success).toBe(false);
    });

    it("refuses what is not an id", () => {
        expect(
            enchantmentSetSchema.safeParse({ enchantments: [{ id: "sharp ness!", level: 1 }] })
                .success
        ).toBe(false);
    });
});

describe("a waiting give", () => {
    it("carries its enchantments", () => {
        const payload = parseQueuedPayload(
            "give",
            JSON.stringify({
                item: "minecraft:bow",
                count: 1,
                enchantments: [{ id: "power", level: 5 }]
            })
        );
        expect(payload).toEqual({
            kind: "give",
            item: "minecraft:bow",
            count: 1,
            enchantments: [{ id: "minecraft:power", level: 5 }]
        });
    });

    it("still reads one written before enchanting existed", () => {
        expect(
            parseQueuedPayload("set-slot", JSON.stringify({ item: "stone", count: 3, slot: 4 }))
        ).toEqual({ kind: "set-slot", item: "stone", count: 3, slot: 4 });
    });
});
