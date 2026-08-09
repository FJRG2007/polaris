/**
 * Handing out an amount, and what it arrives as.
 *
 * A count is what somebody types; stacks are what a player receives. The two
 * were the same number while the field stopped at 64, and stopped being the same
 * the moment it did not - so this pins the split, including the items where a
 * stack is not 64 and a naive divide would hand out sixty-three too few.
 */

import { describe, expect, it } from "vitest";
import { maxStackFor, stacksFor } from "@/lib/apps/minecraft/items";

describe("cutting a total into stacks", () => {
    it("gives one stack when it fits in one", () => {
        expect(stacksFor("minecraft:diamond", 1)).toEqual([1]);
        expect(stacksFor("minecraft:diamond", 64)).toEqual([64]);
    });

    it("splits what does not", () => {
        // The case in the request: 128 is two stacks, not a refusal and not a
        // number the server may or may not take.
        expect(stacksFor("minecraft:diamond", 128)).toEqual([64, 64]);
        expect(stacksFor("minecraft:diamond", 130)).toEqual([64, 64, 2]);
    });

    it("uses the item's own stack size, not 64", () => {
        // Ender pearls stack to 16, and a saddle not at all. Splitting either by
        // 64 would ask for a stack the game cannot make.
        expect(maxStackFor("minecraft:ender_pearl")).toBe(16);
        expect(stacksFor("minecraft:ender_pearl", 20)).toEqual([16, 4]);
        expect(maxStackFor("minecraft:saddle")).toBe(1);
        expect(stacksFor("minecraft:saddle", 3)).toEqual([1, 1, 1]);
    });

    it("adds up to what was asked for, whatever the item", () => {
        for (const id of ["minecraft:diamond", "minecraft:ender_pearl", "minecraft:saddle"]) {
            for (const total of [1, 7, 63, 64, 65, 128, 2304]) {
                const stacks = stacksFor(id, total);
                expect(stacks.reduce((sum, stack) => sum + stack, 0)).toBe(total);
                expect(stacks.every((stack) => stack >= 1 && stack <= maxStackFor(id))).toBe(true);
            }
        }
    });

    it("asks for nothing when nothing was asked for", () => {
        expect(stacksFor("minecraft:diamond", 0)).toEqual([]);
        expect(stacksFor("minecraft:diamond", -5)).toEqual([]);
    });
});
