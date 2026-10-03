/**
 * The beam up to a sky arena, without a server: who counts as standing in it,
 * and which spot on the ground it is put on.
 */

import { describe, expect, it } from "vitest";
import * as boss from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss";
import * as entry from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/beam-entry";

type Kind = entry.EntryColumn["kind"];

/** A ring read from a height function and a kind function, as the server would answer it. */
function read(
    center: { x: number; z: number },
    ring: { half: number; step: number },
    height: (x: number, z: number) => number | null,
    kind: (x: number, z: number) => Kind = () => "ground"
): entry.EntryColumn[] {
    return entry.entryColumns(center, ring).map((one) => ({
        ...one,
        y: height(one.x, one.z),
        kind: kind(one.x, one.z)
    }));
}

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

describe("where the beam goes", () => {
    const center = { x: 0, z: 0 };
    const ring = entry.ENTRY_RINGS[0]!;

    it("reads a square of columns round the players, the center among them", () => {
        const columns = entry.entryColumns(center, { half: 4, step: 2 });
        expect(columns).toHaveLength(25);
        expect(columns).toContainEqual({ x: 0, z: 0 });
        expect(columns).toContainEqual({ x: -4, z: 4 });
        expect(entry.entryColumns(center, entry.ENTRY_RINGS[1]!)).toHaveLength(17 * 17);
    });

    it("on flat open ground, is right by the players, at the ground of its own column", () => {
        const best = entry.rankEntries(
            center,
            read(center, ring, () => 64),
            ring.step
        )[0];
        expect(best?.point).toEqual({ x: 0, y: 64, z: 0 });
    });

    it("keeps clear of a build by a margin, and takes its height from its own column, not the roof", () => {
        // A house 8 high on x 0..6, z 0..6; the ground round it at 64.
        const house = (x: number, z: number) => x >= 0 && x <= 6 && z >= 0 && z <= 6;
        const columns = read(
            center,
            ring,
            (x, z) => (house(x, z) ? 72 : 64),
            (x, z) => (house(x, z) ? "built" : "ground")
        );
        const ranked = entry.rankEntries(center, columns, ring.step);
        expect(ranked.length).toBeGreaterThan(0);
        for (const spot of ranked) {
            expect(spot.point.y).toBe(64);
            const gap = Math.max(
                spot.point.x < 0 ? -spot.point.x : spot.point.x > 6 ? spot.point.x - 6 : 0,
                spot.point.z < 0 ? -spot.point.z : spot.point.z > 6 ? spot.point.z - 6 : 0
            );
            expect(gap).toBeGreaterThan(entry.ENTRY_RADIUS + entry.BUILT_MARGIN);
        }
    });

    it("passes over uneven ground for flat ground further off", () => {
        // A rough slope near the players, a flat meadow from x 6 on.
        const columns = read(center, ring, (x, z) =>
            x >= 6 ? 70 : (x / 2 + z / 2) % 2 === 0 ? 64 : 68
        );
        const best = entry.rankEntries(center, columns, ring.step)[0];
        expect(best?.point.y).toBe(70);
        expect(best!.point.x).toBeGreaterThanOrEqual(8);
    });

    it("takes a gentle rise within a block or two, preferring the flattest", () => {
        const columns = read(center, ring, (x) => 64 + Math.floor(Math.abs(x) / 4));
        const ranked = entry.rankEntries(center, columns, ring.step);
        expect(ranked[0]?.point).toMatchObject({ x: 0, z: 0 });
        expect(ranked.length).toBeGreaterThan(10);
    });

    it("never stands on or next to water, lava or a tree, nor beside a column it could not read", () => {
        const columns = read(
            center,
            ring,
            (x, z) => (x === 6 && z === 6 ? null : 64),
            (x, z) => (x <= 2 ? "wet" : z === -4 ? "tree" : "ground")
        );
        const ranked = entry.rankEntries(center, columns, ring.step);
        expect(ranked.length).toBeGreaterThan(0);
        for (const spot of ranked) {
            expect(spot.point.x).toBeGreaterThan(2 + entry.ENTRY_RADIUS);
            expect(Math.abs(spot.point.z - -4)).toBeGreaterThan(entry.ENTRY_RADIUS);
            expect(Math.abs(spot.point.x - 6) > 2 || Math.abs(spot.point.z - 6) > 2).toBe(true);
            // Never on the edge of the ring, where its neighbours were never read.
            expect(Math.abs(spot.point.x)).toBeLessThan(10);
            expect(Math.abs(spot.point.z)).toBeLessThan(10);
        }
    });

    it("answers nothing when everywhere near is built on", () => {
        const columns = read(
            center,
            ring,
            () => 64,
            (x, z) => ((x + z) % 8 === 0 ? "built" : "ground")
        );
        expect(entry.rankEntries(center, columns, ring.step)).toEqual([]);
    });

    it("judges the wider ring's coarser grid by its next columns", () => {
        const wide = entry.ENTRY_RINGS[1]!;
        const columns = read(center, wide, () => 64);
        const best = entry.rankEntries(center, columns, wide.step)[0];
        expect(best?.point).toEqual({ x: 0, y: 64, z: 0 });
    });
});
