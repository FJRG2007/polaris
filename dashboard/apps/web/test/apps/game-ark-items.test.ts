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
                stack: 100
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
