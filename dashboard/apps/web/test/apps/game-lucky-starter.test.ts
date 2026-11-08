/**
 * The lucky blocks a newcomer to a Lucky blocks server is given, once.
 */

import { describe, expect, it } from "vitest";
import {
    STARTER_BLOCKS,
    STARTER_TAG,
    starterLines,
    STARTER_STORAGE,
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
        expect(lines).toHaveLength(STARTER_BLOCKS + 2);
        for (const line of lines.slice(1)) expect(line).toContain(`@a[tag=!${STARTER_TAG}]`);
    });

    it("gives the datapack's own lucky block, then marks the player served", () => {
        const lines = starterLines();
        expect(lines[1]).toBe(
            `execute as @a[tag=!${STARTER_TAG}] store success storage ${STARTER_STORAGE} given byte 1 run loot give @s loot lucky_blocks:lucky_block`
        );
        expect(lines.at(-1)).toBe(
            `execute if data storage ${STARTER_STORAGE} {given:1b} run tag @a[tag=!${STARTER_TAG}] add ${STARTER_TAG}`
        );
    });

    it("tags nobody when the game gave nothing, as on a server without the datapack", () => {
        // One console session: a failed give does not stop the line after it, so
        // the tag has to hang on a flag the batch clears before any give.
        const lines = starterLines();
        expect(lines[0]).toBe(`data merge storage ${STARTER_STORAGE} {given:0b}`);
        const tags = lines.filter((line) => line.includes(" add "));
        expect(tags).toHaveLength(1);
        expect(tags[0]).toMatch(/^execute if data storage \S+ \{given:1b\} run tag /);
    });

    it("sends nothing a console line cannot carry", () => {
        for (const line of starterLines()) expect(line).not.toMatch(/[\n\r"]/);
    });
});
