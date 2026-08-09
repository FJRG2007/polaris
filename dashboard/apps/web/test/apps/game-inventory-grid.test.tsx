/**
 * The inventory as it is drawn.
 *
 * What is being checked: the grid is the game's own shape whatever the server
 * sent, a stack lands in the slot it was reported in with the picture named after
 * its id, and nothing the server reported is dropped - including the slots a
 * modded server invents, which are the ones a vanilla-shaped grid would silently
 * lose.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryGrid } from "@/app/(app)/apps/installed/[id]/minecraft-inventory";

/** Every slot the grid draws, filled or not. */
function slotCount(markup: string): number {
    return markup.split("<li").length - 1;
}

describe("InventoryGrid", () => {
    it("draws the whole bag even when almost nothing is in it", () => {
        // 27 in the bag, 9 on the hotbar, 4 worn, 1 offhand. An operator has to be
        // able to see the empty room, not only what is being carried.
        const markup = renderToStaticMarkup(
            <InventoryGrid items={[{ slot: 0, id: "minecraft:stone", count: 1 }]} />
        );
        expect(slotCount(markup)).toBe(41);
    });

    it("puts a stack in its own slot, with its picture and its count", () => {
        const markup = renderToStaticMarkup(
            <InventoryGrid
                items={[
                    { slot: 0, id: "minecraft:diamond_sword", count: 1 },
                    { slot: 9, id: "minecraft:cobblestone", count: 64 }
                ]}
            />
        );
        expect(markup).toContain("/mcicons/minecraft_diamond_sword.png");
        expect(markup).toContain("/mcicons/minecraft_cobblestone.png");
        expect(markup).toContain("Hotbar 1: Diamond Sword, 1");
        expect(markup).toContain("Slot 9: Cobblestone, 64");
        // A single item carries no number in the game either.
        expect(markup).not.toContain(">1</span>");
        expect(markup).toContain(">64</span>");
    });

    it("names the armour by what it is worn as", () => {
        const markup = renderToStaticMarkup(
            <InventoryGrid items={[{ slot: 103, id: "minecraft:diamond_helmet", count: 1 }]} />
        );
        expect(markup).toContain("Helmet: Diamond Helmet, 1");
    });

    it("shows a modded slot rather than losing what is in it", () => {
        const markup = renderToStaticMarkup(
            <InventoryGrid items={[{ slot: 200, id: "curios:ring", count: 1 }]} />
        );
        expect(markup).toContain("Elsewhere");
        expect(markup).toContain("Slot 200: Ring, 1");
        // No picture exists for a modded id, so the slot falls back rather than
        // asking the browser for a file that is not there.
        expect(markup).not.toContain("curios");
    });

    it("counts what is being carried, not how many stacks it came in", () => {
        const markup = renderToStaticMarkup(
            <InventoryGrid
                items={[
                    { slot: 0, id: "minecraft:cobblestone", count: 64 },
                    { slot: 1, id: "minecraft:cobblestone", count: 12 }
                ]}
            />
        );
        expect(markup).toContain("76 items in 2 stacks");
    });

    it("draws a stack that is only written down in the slot it is waiting for", () => {
        // The whole reason it is drawn: an item given to somebody who is not on
        // the server cannot be in the bag yet, and a drop that left the square
        // empty was indistinguishable from a drop that had failed.
        const markup = renderToStaticMarkup(
            <InventoryGrid
                items={[]}
                pending={[{ id: "queued-1", slot: 4, item: "minecraft:lantern", count: 3 }]}
            />
        );
        expect(markup).toContain("/mcicons/minecraft_lantern.png");
        expect(markup).toContain("Hotbar 5: 3 x Lantern waiting for them to join");
        expect(markup).toContain(">3</span>");
        expect(markup).toContain("1 stack is waiting for them to join.");
    });

    it("leaves a slot they are already carrying something in alone", () => {
        // The queued write replaces it when they join. Drawing both in one square
        // would be drawing a bag that exists in neither version.
        const markup = renderToStaticMarkup(
            <InventoryGrid
                items={[{ slot: 4, id: "minecraft:stone", count: 1 }]}
                pending={[{ id: "queued-1", slot: 4, item: "minecraft:lantern", count: 3 }]}
            />
        );
        expect(markup).toContain("/mcicons/minecraft_stone.png");
        expect(markup).not.toContain("minecraft_lantern");
        expect(markup).not.toContain("waiting for them to join");
    });

    it("says so when the bag is empty, instead of showing a wall of nothing", () => {
        const markup = renderToStaticMarkup(<InventoryGrid items={[]} />);
        expect(markup).toContain("Nothing in it.");
        expect(slotCount(markup)).toBe(41);
    });
});
