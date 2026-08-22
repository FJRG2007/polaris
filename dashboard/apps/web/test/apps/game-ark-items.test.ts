/**
 * The ARK item catalogue, and the command that hands one over.
 *
 * The command is the part worth testing hard: it is built from a path that comes
 * out of a generated file and a player id that comes out of a binary one, and it
 * is run on a game server. Everything else here is what a picker shows.
 */

import { describe, expect, it } from "vitest";
import { arkItems, findArkItem } from "@/lib/apps/ark/item-catalog";
import {
    ARK_BLUEPRINT_PATH,
    arkGiveCommand,
    arkItemIconUrl,
    arkStackCount,
    describeArkGive,
    describeArkStacks,
    MAX_ARK_GIVE,
    readArkItemCatalog,
    searchArkItems
} from "@/lib/apps/ark/items";

const WOOD = "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Wood.PrimalItemResource_Wood";

describe("readArkItemCatalog", () => {
    it("reads what the manifest holds", () => {
        expect(
            readArkItemCatalog([{ key: "PrimalItemResource_Wood", name: "Wood", stack: 100 }])
        ).toEqual([
            {
                id: "PrimalItemResource_Wood",
                label: "Wood",
                search: "wood primalitemresource_wood",
                stack: 100,
                rank: 0
            }
        ]);
    });

    it("drops entries it cannot use rather than drawing a broken tile", () => {
        expect(
            readArkItemCatalog([
                { key: "../../etc/passwd", name: "Nope", stack: 1 },
                { key: "PrimalItemResource_Wood", name: "", stack: 1 },
                "not an item",
                null
            ])
        ).toEqual([]);
    });

    it("is an empty catalogue for anything that is not a list", () => {
        expect(readArkItemCatalog({ items: [] })).toEqual([]);
        expect(readArkItemCatalog(null)).toEqual([]);
    });

    it("falls back to one to a stack when the manifest does not say", () => {
        expect(readArkItemCatalog([{ key: "PrimalItem_WeaponGun", name: "Simple Pistol" }])[0]?.stack).toBe(1);
    });
});

describe("searchArkItems", () => {
    const items = readArkItemCatalog([
        { key: "PrimalItemResource_Wood", name: "Wood", stack: 100 },
        { key: "PrimalItemStructure_WoodTable", name: "Wooden Table", stack: 1 },
        { key: "PrimalItemAmmo_ArrowTranq", name: "Tranq Arrow", stack: 100 }
    ]);

    it("puts the exact name first, not the longer one that contains it", () => {
        expect(searchArkItems(items, "wood", 5).map((item) => item.label)).toEqual(["Wood", "Wooden Table"]);
    });

    it("finds an item by the class an operator read in a mod's notes", () => {
        expect(searchArkItems(items, "arrowtranq", 5).map((item) => item.label)).toEqual(["Tranq Arrow"]);
    });

    it("still answers a typo", () => {
        expect(searchArkItems(items, "wodo", 5).map((item) => item.label)).toContain("Wood");
    });

    it("puts the items nobody has a picture of behind the ones it can draw", () => {
        // A first screen of empty boxes reads as a broken panel, even when every
        // one of them is a real item.
        const mixed = readArkItemCatalog([
            { key: "PrimalItemStructure_PortalA", name: "Aaa Portal", stack: 1, icon: false },
            { key: "PrimalItemResource_Wood", name: "Wood", stack: 100 }
        ]);
        expect(mixed.map((item) => item.label)).toEqual(["Wood", "Aaa Portal"]);
        // And among equally good matches for a query, too.
        const both = readArkItemCatalog([
            { key: "PrimalItemStructure_PortalWood", name: "Wood Portal", stack: 1, icon: false },
            { key: "PrimalItemStructure_WoodWall", name: "Wood Wall", stack: 100 }
        ]);
        expect(searchArkItems(both, "wood ", 5)[0]?.label).toBe("Wood Wall");
    });
});

describe("arkItemIconUrl", () => {
    it("names the picture after the class", () => {
        expect(arkItemIconUrl("PrimalItemResource_Wood")).toBe("/arkicons/PrimalItemResource_Wood.webp");
    });

    it("refuses to build a URL out of anything else", () => {
        expect(arkItemIconUrl("../../secret")).toBeNull();
        expect(arkItemIconUrl("")).toBeNull();
    });
});

/**
 * The sentence under the quantity box, which was contradicting the box.
 *
 * Ask for 125 of something that stacks to 100 and it read "2 stacks of 100" -
 * a sentence that says two hundred. The count was right about how many stacks
 * arrive and wrong about what is in them, and the one an admin acts on is the
 * sentence.
 */
describe("describeArkStacks", () => {
    it("names what is left over rather than rounding it up to a full stack", () => {
        expect(describeArkStacks(100, 125)).toBe("Arrives as a stack of 100 and 25.");
        expect(describeArkStacks(100, 350)).toBe("Arrives as 3 stacks of 100 and 50.");
    });

    it("says nothing about a remainder there is not", () => {
        expect(describeArkStacks(100, 200)).toBe("Arrives as 2 stacks of 100.");
    });

    it("stays quiet when it all fits in one stack", () => {
        // Nothing to describe, and a line saying so is a line in the way.
        expect(describeArkStacks(100, 100)).toBeNull();
        expect(describeArkStacks(100, 1)).toBeNull();
    });

    it("counts gear as pieces, because gear does not stack", () => {
        // "5 stacks of 1" is arithmetic rather than English.
        expect(describeArkStacks(1, 5)).toBe("Arrives as 5 separate pieces.");
    });

    it("never adds up to more than was asked for", () => {
        // The property the original broke. Whatever the sentence names has to
        // come to the number in the box.
        for (const stack of [3, 20, 100, 300]) {
            for (const quantity of [1, 2, 7, 99, 100, 101, 125, 250, 999, 1000]) {
                const said = describeArkStacks(stack, quantity);
                if (!said) continue;
                const numbers = [...said.matchAll(/(\d+)/g)].map((match) => Number(match[1]));
                const [count, size, rest = 0] = said.startsWith("Arrives as a stack")
                    ? [1, numbers[0]!, numbers[1] ?? 0]
                    : [numbers[0]!, numbers[1]!, numbers[2] ?? 0];
                expect(count * size + rest).toBe(quantity);
            }
        }
    });
});

describe("arkStackCount", () => {
    it("says how many stacks a quantity arrives as", () => {
        expect(arkStackCount(100, 250)).toBe(3);
        expect(arkStackCount(100, 100)).toBe(1);
        expect(arkStackCount(1, 5)).toBe(5);
    });
});

describe("arkGiveCommand", () => {
    it("writes the command the way the game's own admin lists do", () => {
        expect(
            arkGiveCommand({ playerId: "1234567890", blueprintPath: WOOD, quantity: 100, quality: 0, blueprint: false })
        ).toBe(`GiveItemToPlayer 1234567890 "Blueprint'${WOOD}'" 100 0 0`);
    });

    it("hands over the blueprint when that is what was asked for", () => {
        expect(
            arkGiveCommand({ playerId: "1", blueprintPath: WOOD, quantity: 1, quality: 65, blueprint: true })
        ).toBe(`GiveItemToPlayer 1 "Blueprint'${WOOD}'" 1 65 1`);
    });

    it("clamps a quantity somebody typed an extra nought onto", () => {
        expect(
            arkGiveCommand({
                playerId: "1",
                blueprintPath: WOOD,
                quantity: 999_999,
                quality: 0,
                blueprint: false
            })
        ).toContain(` ${MAX_ARK_GIVE} 0 0`);
    });

    it("refuses a target that is not an in-game id", () => {
        // The Steam id is the other kind of number, and the commands that take this
        // one do nothing at all when handed it.
        expect(() =>
            arkGiveCommand({
                playerId: "not-a-number",
                blueprintPath: WOOD,
                quantity: 1,
                quality: 0,
                blueprint: false
            })
        ).toThrow();
    });

    it("refuses a path that could carry a second command", () => {
        for (const path of ["/Game/A'\" | Broadcast hi", "Blueprint'/Game/A.A'", "/etc/passwd", ""]) {
            expect(() =>
                arkGiveCommand({ playerId: "1", blueprintPath: path, quantity: 1, quality: 0, blueprint: false })
            ).toThrow();
        }
    });
});

describe("the vendored catalogue", () => {
    it("knows the item every ARK server is made of", () => {
        const wood = findArkItem("PrimalItemResource_Wood");
        expect(wood?.name).toBe("Wood");
        expect(wood?.bp).toBe(WOOD);
        expect(wood?.stack).toBe(100);
    });

    it("carries no path that would be refused on the way out", () => {
        // Generated from someone else's data file, so the shape is proved here
        // rather than assumed: a bad line would otherwise only show up as a give
        // that failed on a live server.
        const wrong = arkItems().filter((item) => !ARK_BLUEPRINT_PATH.test(item.bp));
        expect(wrong.map((item) => item.key)).toEqual([]);
    });

    it("ends every path at the object rather than at the generated class", () => {
        expect(arkItems().filter((item) => item.bp.endsWith("_C"))).toEqual([]);
    });
});

/**
 * One line of a give, as the form's list says it.
 *
 * The list exists so that handing somebody a weapon, its ammunition and something
 * to wear is one errand rather than three trips through the form, and a line
 * nobody can read back is a list nobody can check before pressing send.
 */
describe("describeArkGive", () => {
    const line = { key: "PrimalItemResource_Wood", quantity: 100, quality: 0, blueprint: false };

    it("says how many of what", () => {
        expect(describeArkGive("Wood", line)).toBe("100 x Wood");
    });

    it("says when it is the blueprint rather than the thing", () => {
        expect(describeArkGive("Assault Rifle", { ...line, quantity: 1, blueprint: true })).toBe(
            "1 x Assault Rifle blueprint"
        );
    });

    // Quality is off by default and is the difference between a pistol and the
    // best pistol on the server, so a line carrying one has had it typed in.
    it("says the quality when there is one, and stays quiet when there is not", () => {
        expect(describeArkGive("Pistol", { ...line, quantity: 1, quality: 40 })).toBe("1 x Pistol, quality 40");
        expect(describeArkGive("Pistol", { ...line, quantity: 1 })).toBe("1 x Pistol");
    });
});
