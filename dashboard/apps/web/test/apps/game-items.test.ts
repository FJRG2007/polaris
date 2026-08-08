import { describe, expect, it } from "vitest";
import {
    itemIconUrl,
    itemLabel,
    itemName,
    normalizeItemId,
    readItemCatalog,
    searchItems,
    typedItemId
} from "@/lib/apps/minecraft/items";

describe("normalizeItemId", () => {
    it("namespaces a bare name, because `give Alice stone` is what gets typed", () => {
        expect(normalizeItemId("stone")).toBe("minecraft:stone");
    });

    it("leaves an id that already names its namespace alone", () => {
        expect(normalizeItemId("create:cogwheel")).toBe("create:cogwheel");
    });

    it("trims and lowercases, so a pasted id is not a different item", () => {
        expect(normalizeItemId("  Minecraft:Diamond_Sword ")).toBe("minecraft:diamond_sword");
    });

    it("refuses anything that is not an item id", () => {
        // A command cannot be built out of these, and neither can a URL.
        expect(normalizeItemId("")).toBeNull();
        expect(normalizeItemId("stone; op alice")).toBeNull();
        expect(normalizeItemId("../../etc/passwd")).toBeNull();
        expect(normalizeItemId("minecraft:stone extra")).toBeNull();
    });
});

describe("typedItemId", () => {
    it("takes a written-out id, which is how a modded item gets in", () => {
        expect(typedItemId("create:cogwheel")).toBe("create:cogwheel");
        expect(typedItemId("minecraft:diamond")).toBe("minecraft:diamond");
    });

    it("refuses a bare word, which is a search and not a choice", () => {
        // The dangerous case: "swor" on the way to a diamond sword is a
        // well-formed id and no item at all, and Enter would hand it to `give`.
        expect(typedItemId("swor")).toBeNull();
        expect(typedItemId("diamond")).toBeNull();
        expect(typedItemId("")).toBeNull();
    });

    it("still refuses something that only looks namespaced", () => {
        expect(typedItemId("stone; op alice:now")).toBeNull();
    });
});

describe("itemIconUrl", () => {
    it("points at the staged set, named after the id", () => {
        expect(itemIconUrl("minecraft:diamond_sword")).toBe("/mcicons/minecraft_diamond_sword.png");
    });

    it("namespaces a bare name first", () => {
        expect(itemIconUrl("apple")).toBe("/mcicons/minecraft_apple.png");
    });

    it("has no picture for a modded id, rather than one that always 404s", () => {
        expect(itemIconUrl("create:cogwheel")).toBeNull();
    });

    it("has no picture for something that is not an id at all", () => {
        expect(itemIconUrl("../secret")).toBeNull();
    });
});

describe("itemLabel", () => {
    it("reads the id as words", () => {
        expect(itemLabel("minecraft:diamond_sword")).toBe("Diamond Sword");
        expect(itemLabel("minecraft:tnt")).toBe("Tnt");
    });

    it("drops the namespace, which is not part of the name", () => {
        expect(itemName("minecraft:apple")).toBe("apple");
        expect(itemName("apple")).toBe("apple");
    });
});

describe("readItemCatalog", () => {
    it("turns the manifest into namespaced, searchable entries", () => {
        expect(readItemCatalog(["diamond_sword"])).toEqual([
            { id: "minecraft:diamond_sword", label: "Diamond Sword", search: "diamond sword diamond_sword" }
        ]);
    });

    it("is empty for anything that is not a list of names, so the picker degrades", () => {
        expect(readItemCatalog(null)).toEqual([]);
        expect(readItemCatalog({ items: ["stone"] })).toEqual([]);
        expect(readItemCatalog([1, "not an id!", "stone"]).map((item) => item.id)).toEqual(["minecraft:stone"]);
    });
});

describe("searchItems", () => {
    const catalog = readItemCatalog([
        "block_of_diamond",
        "diamond",
        "diamond_sword",
        "stone",
        "sword_of_nothing"
    ]);

    it("puts the exact name first, then what starts with the query", () => {
        // An operator typing "diamond" wants the diamond, not everything made of it.
        expect(searchItems(catalog, "diamond", 10).map((item) => item.id)).toEqual([
            "minecraft:diamond",
            "minecraft:diamond_sword",
            "minecraft:block_of_diamond"
        ]);
    });

    it("matches across the underscore, so typed spaces still find things", () => {
        expect(searchItems(catalog, "diamond sw", 10).map((item) => item.id)).toEqual(["minecraft:diamond_sword"]);
    });

    it("returns the head of the set for an empty query, and never more than asked", () => {
        expect(searchItems(catalog, "", 2)).toHaveLength(2);
        expect(searchItems(catalog, "   ", 3)).toHaveLength(3);
    });

    it("finds nothing rather than everything when nothing matches", () => {
        expect(searchItems(catalog, "beacon", 10)).toEqual([]);
    });
});
