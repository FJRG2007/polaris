/**
 * An arena kind played on past a death moves each entrant's spawn point onto
 * their spot in it, and gives them their own back at the end: read in either
 * of the game's two spellings, put back in its own world, and the world's
 * spawn for whoever had none.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import type { Entrant } from "@polaris-app/game-servers/src/lib/minecraft/events/state";

const entrant = (spawn: Entrant["spawn"]): Entrant => ({
    name: "Ana",
    uuid: null,
    dimension: "minecraft:overworld",
    x: 0,
    y: 64,
    z: 0,
    yaw: 0,
    pitch: 0,
    gamemode: "survival",
    side: 0,
    away: true,
    tagged: true,
    stash: null,
    ...(spawn === undefined ? {} : { spawn })
});

describe("an entrant's spawn point", () => {
    it("reads the spawn up to 1.21.4, in its own world", () => {
        const spawns = arena.readSpawns([
            "Ana has the following entity data: 10\nBen has the following entity data: -5",
            "Ana has the following entity data: 70\nBen has the following entity data: 64",
            "Ana has the following entity data: -20\nBen has the following entity data: 8",
            'Ana has the following entity data: "minecraft:the_nether"',
            "Found no elements matching respawn.pos",
            "Found no elements matching respawn.dimension"
        ]);
        expect(Object.fromEntries(spawns)).toEqual({
            Ana: { dimension: "minecraft:the_nether", x: 10, y: 70, z: -20 },
            Ben: { dimension: "minecraft:overworld", x: -5, y: 64, z: 8 }
        });
    });

    it("reads the respawn compound from 1.21.5, and leaves out a spawn read in part", () => {
        const spawns = arena.readSpawns([
            "Cy has the following entity data: 1",
            "",
            "Cy has the following entity data: 2",
            "",
            "Ana has the following entity data: [I; 3, 65, -7]",
            'Ana has the following entity data: "minecraft:the_end"'
        ]);
        expect(Object.fromEntries(spawns)).toEqual({
            Ana: { dimension: "minecraft:the_end", x: 3, y: 65, z: -7 }
        });
    });

    it("faces the spot's way only where the game takes an angle (1.16.2)", () => {
        const spot = { x: 4, y: 101, z: -3, yaw: 180 };
        expect(arena.spawnAt("Ana", spot, true)).toBe(
            "execute in minecraft:overworld run spawnpoint Ana 4 101 -3 180"
        );
        expect(arena.spawnAt("Ana", spot, false)).toBe(
            "execute in minecraft:overworld run spawnpoint Ana 4 101 -3"
        );
    });

    it("puts back the spawn it read, the world's for none, and nothing it never moved", () => {
        expect(
            arena.spawnBack(entrant({ dimension: "minecraft:the_nether", x: 1, y: 2, z: 3 }))
        ).toEqual(["execute in minecraft:the_nether run spawnpoint Ana 1 2 3"]);
        expect(arena.spawnBack(entrant(null))).toEqual(["spawnpoint Ana ~ ~ ~"]);
        expect(
            arena.spawnBack(entrant({ dimension: "not a world; op Ana", x: 1, y: 2, z: 3 }))
        ).toEqual(["spawnpoint Ana ~ ~ ~"]);
        expect(arena.spawnBack(entrant(undefined))).toEqual([]);
    });
});
