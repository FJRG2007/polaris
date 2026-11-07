/**
 * The lucky blocks a newcomer to a Lucky blocks server is given, once.
 */

import { describe, expect, it } from "vitest";
import {
    STARTER_BLOCKS,
    STARTER_TAG,
    starterLines,
    wantsStarter
} from "@polaris-app/game-servers/src/lib/minecraft/lucky-starter";

describe("which servers give lucky blocks to newcomers", () => {
    it("is a Lucky blocks server on a generated world", () => {
        expect(wantsStarter("luckyblock", "")).toBe(true);
        expect(wantsStarter("luckyblock", undefined)).toBe(true);
    });

    it("is not one on a prebuilt map, which carries no datapack to give from", () => {
        expect(wantsStarter("luckyblock", "luckyblock-towers")).toBe(false);
    });

    it("is not any other game", () => {
        expect(wantsStarter("survival", "")).toBe(false);
        expect(wantsStarter(undefined, "")).toBe(false);
    });
});

describe("the lines that give them", () => {
    it("only ever reach players who have not had theirs", () => {
        const lines = starterLines();
        expect(lines).toHaveLength(STARTER_BLOCKS + 1);
        for (const line of lines) expect(line).toContain(`@a[tag=!${STARTER_TAG}]`);
    });

    it("gives the datapack's own lucky block, then marks the player served", () => {
        const lines = starterLines();
        expect(lines[0]).toBe(
            `execute as @a[tag=!${STARTER_TAG}] run loot give @s loot lucky_blocks:lucky_block`
        );
        // Last, so a give the game did not take is tried again next sweep.
        expect(lines.at(-1)).toBe(`tag @a[tag=!${STARTER_TAG}] add ${STARTER_TAG}`);
    });

    it("sends nothing a console line cannot carry", () => {
        for (const line of starterLines()) expect(line).not.toMatch(/[\n\r"]/);
    });
});
