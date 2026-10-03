import { describe, expect, it } from "vitest";
import * as hill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill";
import * as search from "@polaris-app/game-servers/src/lib/minecraft/events/place-search";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";

const place = { x: 100, y: 64, z: -40 };

describe("a king of the hill's platform", () => {
    it("is one layer round the circle, with room to be pushed out onto", () => {
        expect(hill.platformBox(place, 6)).toEqual({
            x1: 91,
            y1: 64,
            z1: -49,
            x2: 109,
            y2: 64,
            z2: -31
        });
        // The air over it is proven empty too before anything goes in.
        expect(hill.proofBox(place, 6)).toEqual({
            x1: 91,
            y1: 64,
            z1: -49,
            x2: 109,
            y2: 68,
            z2: -31
        });
    });

    it("brings everybody in round the circle, just outside it, facing the middle", () => {
        const spots = hill.entrySpots(place, 6, 4);
        expect(spots).toHaveLength(4);
        for (const spot of spots) {
            expect(Math.round(Math.hypot(spot.x - place.x, spot.z - place.z))).toBe(7);
            // Facing the middle: a step that way is a step closer.
            const rad = (spot.yaw * Math.PI) / 180;
            const ahead = { x: spot.x - Math.sin(rad), z: spot.z + Math.cos(rad) };
            expect(Math.hypot(ahead.x - place.x, ahead.z - place.z)).toBeLessThan(
                Math.hypot(spot.x - place.x, spot.z - place.z)
            );
        }
    });

    it("stands them on the ground where the server can say where it is", () => {
        const [spot] = hill.entrySpots(place, 6, 1);
        expect(hill.enterLines("Ana", spot!, true)).toEqual([
            "tag Ana add pe_arena",
            `execute in minecraft:overworld positioned ${spot!.x + 0.5} ${spot!.y + 6} ${spot!.z + 0.5} positioned over motion_blocking_no_leaves run tp Ana ~ ~ ~ ${spot!.yaw} 0`,
            "gamemode adventure Ana"
        ]);
        expect(hill.enterLines("Ana", spot!, false)[1]).toBe(
            `execute in minecraft:overworld run tp Ana ${spot!.x + 0.5} 64 ${spot!.z + 0.5} ${spot!.yaw} 0`
        );
    });

    it("brings back whoever is knocked right off, and nobody who is only outside the circle", () => {
        expect(hill.strayed({ x: 100, y: 64, z: -40 }, place, 6)).toBe(false);
        expect(hill.strayed({ x: 108, y: 64, z: -40 }, place, 6)).toBe(false);
        expect(hill.strayed({ x: 100, y: 58, z: -40 }, place, 6)).toBe(true);
        expect(hill.strayed({ x: 130, y: 64, z: -40 }, place, 6)).toBe(true);
    });

    it("keeps everybody it brought from harm, and nobody else", () => {
        const lines = hill.protectLines();
        expect(lines).toContain("effect give @a[tag=pe_arena] minecraft:resistance 10 3 true");
        expect(lines).toContain("effect give @a[tag=pe_arena] minecraft:fire_resistance 10 0 true");
        expect(lines).toContain("effect give @a[tag=pe_arena] minecraft:water_breathing 10 0 true");
        expect(lines.every((line) => line.includes("@a[tag=pe_arena]"))).toBe(true);
    });
});

describe("where an event looked for its place", () => {
    it("sums up the tries: how many, how far, and what stopped them, most first", () => {
        const from = { x: 0, z: 0, near: "Ana" };
        let log: search.PlaceTry[] = [];
        for (const why of ["water", "built", "water", "homes"] as const)
            log = search.withTry(log, { x: 30, z: 40, why });
        expect(search.summarize(from, log, true)).toEqual({
            from,
            tries: 4,
            reach: 50,
            why: [
                { why: "water", count: 2 },
                { why: "built", count: 1 },
                { why: "homes", count: 1 }
            ],
            overSea: true
        });
    });

    it("keeps only the latest tries", () => {
        let log: search.PlaceTry[] = [];
        for (let index = 0; index < search.MOST_TRIES_KEPT + 5; index += 1)
            log = search.withTry(log, { x: index, z: 0, why: "uneven" });
        expect(log).toHaveLength(search.MOST_TRIES_KEPT);
        expect(log[0]!.x).toBe(5);
    });
});

describe("a team duel between two looks", () => {
    it("shields at once whoever is already down to their last hearts", () => {
        expect(duel.shieldLow(3)).toBe(
            "effect give @a[tag=pe_arena,scores={pe_hp=..6}] minecraft:resistance 2 4 true"
        );
    });
});
