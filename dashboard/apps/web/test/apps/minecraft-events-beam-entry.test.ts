/**
 * The beam up to a sky arena, without a server: who counts as standing in it.
 */

import { describe, expect, it } from "vitest";
import * as boss from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss";
import * as entry from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/beam-entry";

describe("who stands in the beam", () => {
    const lift = { x: 100, y: 64, z: -40 };

    it("is a box round its column from under its ground to well over it, in the Overworld", () => {
        expect(entry.inEntry(lift)).toBe(
            "execute in minecraft:overworld as @a[x=98,y=62,z=-42,dx=4,dy=8,dz=4,tag=!pe_in,gamemode=!creative,gamemode=!spectator] run data get entity @s Pos"
        );
        expect(boss.inLift(lift)).toBe(entry.inEntry(lift));
    });

    it("counts a player on the ground anywhere across it, a step down or a jump up", () => {
        for (const dy of [-entry.ENTRY_BELOW, -1, 0, 1, 2.5, entry.ENTRY_ABOVE]) {
            expect(entry.standsIn(lift, { x: 100.5, y: 64 + dy, z: -39.5 })).toBe(true);
        }
        for (const [dx, dz] of [
            [-2, 0],
            [2.7, 0],
            [0, -2],
            [2.7, 2.7]
        ] as const) {
            expect(entry.standsIn(lift, { x: 100.5 + dx, y: 64, z: -39.5 + dz })).toBe(true);
        }
    });

    it("leaves out whoever is far over it, deep under it, or off to the side", () => {
        expect(entry.standsIn(lift, { x: 100.5, y: 64 + entry.ENTRY_ABOVE + 1.5, z: -39.5 })).toBe(
            false
        );
        expect(entry.standsIn(lift, { x: 100.5, y: 64 - entry.ENTRY_BELOW - 2, z: -39.5 })).toBe(
            false
        );
        expect(entry.standsIn(lift, { x: 105.5, y: 64, z: -39.5 })).toBe(false);
        expect(entry.standsIn(lift, { x: 100.5, y: 64, z: -45 })).toBe(false);
    });

    it("never needed a player to build up: one on the ground at its column is in it", () => {
        // The live report: the beam stood at a roof's height, eight over the ground.
        const old = { x: 100, y: 72, z: -40 };
        expect(entry.standsIn(old, { x: 100.5, y: 64, z: -39.5 })).toBe(false);
        expect(entry.standsIn(lift, { x: 100.5, y: 64, z: -39.5 })).toBe(true);
    });
});
