import { describe, expect, it } from "vitest";
import * as hill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as search from "@polaris-app/game-servers/src/lib/minecraft/events/place-search";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";

const place = { x: 100, y: 64, z: -40 };

describe("the ring played with fists only", () => {
    const settings = (over: Partial<hill.RingSettings> = {}): hill.RingSettings => ({
        seed: "run-1",
        radius: 8,
        players: 4,
        rounds: 3,
        shrinks: true,
        moves: true,
        ...over
    });
    const total = 3 * 60_000;

    it("never gets smaller than its players need, nor than two blocks, nor bigger than it starts", () => {
        expect(hill.leastRadius(8, 2)).toBe(2);
        expect(hill.leastRadius(8, 4)).toBe(2);
        expect(hill.leastRadius(8, 8)).toBe(3);
        expect(hill.leastRadius(8, 16)).toBe(4);
        expect(hill.leastRadius(3, 16)).toBe(3);
        expect(hill.leastRadius(6, 1)).toBe(2);
    });

    it("starts each round whole and in the middle, and is at its smallest when the double points start", () => {
        const start = hill.ringAt(settings(), total, 0);
        expect(start).toEqual({ round: 1, pause: false, sprint: false, dx: 0, dz: 0, radius: 8 });
        // A round is a minute; the last 20 seconds of it count double.
        const sprint = hill.ringAt(settings(), total, 40_000);
        expect(sprint.sprint).toBe(true);
        expect(sprint.radius).toBe(hill.leastRadius(8, 4));
        expect(hill.ringAt(settings(), total, 39_000).sprint).toBe(false);
        // Shrinks a block at a time, never growing within a round.
        let last = 8;
        for (let ms = 0; ms < 60_000; ms += 1000) {
            const now = hill.ringAt(settings(), total, ms).radius;
            expect(last - now).toBeGreaterThanOrEqual(0);
            expect(last - now).toBeLessThanOrEqual(1);
            last = now;
        }
        // The next round: a pause with it whole again, then play.
        const pause = hill.ringAt(settings(), total, 61_000);
        expect(pause).toMatchObject({
            round: 2,
            pause: true,
            sprint: false,
            dx: 0,
            dz: 0,
            radius: 8
        });
        expect(hill.ringAt(settings(), total, 60_000 + hill.RING_PAUSE_SECONDS * 1000).pause).toBe(
            false
        );
        expect(hill.ringAt(settings(), total, total + 5000).round).toBe(3);
    });

    it("moves a block at a time, never off the platform's floor, the same for the same run", () => {
        let last = { dx: 0, dz: 0 };
        let moved = false;
        for (let ms = 0; ms < total; ms += 1000) {
            const ring = hill.ringAt(settings(), total, ms);
            expect(ring).toEqual(hill.ringAt(settings(), total, ms));
            // Inside the floor: the ring's far edge never past the platform's.
            expect(Math.hypot(ring.dx, ring.dz) + ring.radius).toBeLessThanOrEqual(
                8 + hill.MARGIN - 1
            );
            if (!ring.pause && ring.round === hill.ringAt(settings(), total, ms - 1000).round)
                expect(
                    Math.abs(ring.dx - last.dx) + Math.abs(ring.dz - last.dz)
                ).toBeLessThanOrEqual(1);
            if (ring.dx !== 0 || ring.dz !== 0) moved = true;
            last = ring;
        }
        expect(moved).toBe(true);
        expect(hill.ringAt(settings({ seed: "run-2" }), total, 50_000)).not.toEqual(
            hill.ringAt(settings(), total, 50_000)
        );
    });

    it("stays still and whole when the event switches both off", () => {
        for (let ms = 0; ms < total; ms += 5000) {
            const ring = hill.ringAt(settings({ shrinks: false, moves: false }), total, ms);
            expect([ring.dx, ring.dz, ring.radius]).toEqual([0, 0, 8]);
        }
        // Only moving: it drifts, whole.
        const drifting = hill.ringAt(settings({ shrinks: false }), total, 50_000);
        expect(drifting.radius).toBe(8);
        expect(Math.hypot(drifting.dx, drifting.dz)).toBeLessThanOrEqual(hill.MARGIN - 1);
        // One round: no pause anywhere.
        expect(hill.ringAt(settings({ rounds: 1 }), total, 61_000).pause).toBe(false);
    });

    it("scores everybody in it, and three times over whoever is in it alone", () => {
        expect(hill.scoreLines({ x: 10, y: 70, z: -4 }, 3, 4)).toEqual([
            "scoreboard objectives add pe_kin dummy",
            "execute in minecraft:overworld positioned 10.5 70 -3.5 store result score #inside pe_kin if entity @a[tag=pe_arena,distance=..3,gamemode=!spectator]",
            "execute in minecraft:overworld positioned 10.5 70 -3.5 as @a[tag=pe_arena,distance=..3,gamemode=!spectator] run scoreboard players add @s pe_score 4",
            "execute if score #inside pe_kin matches 1 in minecraft:overworld positioned 10.5 70 -3.5 as @a[tag=pe_arena,distance=..3,gamemode=!spectator] run scoreboard players add @s pe_score 8"
        ]);
    });

    it("scores one, two or thirty in the ring with the same lines, each of them", () => {
        // The game's own reading of the lines, for `inRing` players in the ring.
        const scored = (inRing: number, seconds: number) => {
            const scores = new Map<string, number>();
            const names = Array.from({ length: inRing }, (_, index) => `P${index}`);
            for (const line of hill.scoreLines({ x: 0, y: 64, z: 0 }, 4, seconds)) {
                const add = / as @a\[[^\]]+\] run scoreboard players add @s pe_score (\d+)$/.exec(line);
                if (!add) continue;
                if (line.includes("matches 1 ") && inRing !== 1) continue;
                for (const name of names) scores.set(name, (scores.get(name) ?? 0) + Number(add[1]));
            }
            return { lines: hill.scoreLines({ x: 0, y: 64, z: 0 }, 4, seconds).length, scores };
        };
        expect(scored(1, 2).scores.get("P0")).toBe(6);
        for (const many of [2, 30]) {
            const { lines, scores } = scored(many, 2);
            expect(lines).toBe(4);
            expect(scores.size).toBe(many);
            for (const score of scores.values()) expect(score).toBe(2);
        }
        // A sprint's seconds come doubled, alone or not.
        expect(scored(1, 4).scores.get("P0")).toBe(12);
    });

    it("starts everybody inside the whole ring, two blocks in from its edge", () => {
        const place = { x: 100, y: 70, z: -20 };
        for (const count of [1, 2, 7, 16]) {
            for (const spot of hill.startSpots(place, 8, count)) {
                const far = Math.hypot(spot.x - place.x, spot.z - place.z);
                expect(far).toBeLessThanOrEqual(8 - hill.START_MARGIN + 0.5);
            }
        }
        // The smallest ring: everybody in its middle.
        expect(hill.startSpots(place, 2, 3).every((spot) => spot.x === 100 && spot.z === -20)).toBe(true);
    });

    it("neither shrinks nor moves before the grace after Go, or after a round's pause", () => {
        const total = 5 * 60_000;
        const set = settings({ rounds: 3, shrinks: true, moves: true });
        const grace = hill.GRACE_SECONDS * 1000;
        for (let ms = 0; ms < grace; ms += 250) {
            const ring = hill.ringAt(set, total, ms);
            expect([ring.radius, ring.dx, ring.dz]).toEqual([8, 0, 0]);
        }
        const second = hill.roundMs(total, 3) + hill.RING_PAUSE_SECONDS * 1000;
        for (let ms = 0; ms < grace; ms += 250) {
            const ring = hill.ringAt(set, total, second + ms);
            expect([ring.round, ring.radius, ring.dx, ring.dz]).toEqual([2, 8, 0, 0]);
        }
        // And still at its least by the sprint.
        const length = hill.roundMs(total, 3);
        const sprint = hill.ringAt(set, total, length - 1_000);
        expect(sprint.sprint).toBe(true);
        expect(sprint.radius).toBe(hill.leastRadius(8, set.players));
    });

    it("is drawn again only on the platform's own floor", () => {
        const floor = { x: 100, y: 64, z: -40 };
        const box = hill.platformBox(floor, 8);
        const lines = hill.redrawLines(floor, 8, { x: 102, y: 64, z: -41 }, 3);
        expect(lines[0]).toBe(
            `execute in minecraft:overworld run fill ${box.x1} 64 ${box.z1} ${box.x2} 64 ${box.z2} minecraft:smooth_stone replace minecraft:yellow_concrete`
        );
        for (const line of lines.slice(1)) {
            const [x, y, z] = line.split(" fill ")[1]!.split(" ").map(Number);
            expect(y).toBe(64);
            expect(x! > box.x1 && x! < box.x2 && z! > box.z1 && z! < box.z2).toBe(true);
            expect(line.endsWith("minecraft:yellow_concrete replace minecraft:smooth_stone")).toBe(
                true
            );
        }
    });

    it("crowns the one alone at the top, nobody on a tie or at nothing", () => {
        expect(hill.leaderOf({ Ana: 10, Ben: 4 })).toBe("Ana");
        expect(hill.leaderOf({ Ana: 10, Ben: 10 })).toBeNull();
        expect(hill.leaderOf({ Ana: 0, Ben: 0 })).toBeNull();
        expect(hill.leaderOf({})).toBeNull();
    });
});

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

    it("knows who stands on the platform, and who is still on the way or under it", () => {
        // `place` is the circle's height: the floor's top.
        expect(hill.onPlatform({ x: 100.5, y: 64, z: -40.5 }, place, 6)).toBe(true);
        expect(hill.onPlatform({ x: 91.2, y: 65.2, z: -48.7 }, place, 6)).toBe(true);
        expect(hill.onPlatform({ x: 90.5, y: 64, z: -40 }, place, 6)).toBe(false);
        expect(hill.onPlatform({ x: 100, y: 60, z: -40 }, place, 6)).toBe(false);
        expect(hill.onPlatform({ x: 0, y: 70, z: 0 }, place, 6)).toBe(false);
        expect(
            hill.notArrived(
                ["Ana", "Ben", "Cy"],
                [
                    { name: "ana", x: 100, y: 64, z: -40 },
                    { name: "Ben", x: 0, y: 70, z: 0 }
                ],
                place,
                6
            )
        ).toEqual(["Ben", "Cy"]);
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

    it("sends whoever is brought low back healed whole at once, with nothing healing them over time", () => {
        const lines = duel.sendBack("Ben", { x: 1, y: 2, z: 3, yaw: 180 });
        expect(lines).toContain("effect give Ben minecraft:instant_health 1 3 true");
        expect(lines.some((line) => line.includes("minecraft:regeneration"))).toBe(false);
    });

    it("hands the shield over to go in the off hand", () => {
        expect(duel.duelKit("iron")).toEqual(["minecraft:iron_sword", duel.OFFHAND_ITEM]);
        expect(duel.OFFHAND_ITEM).toBe("minecraft:shield");
    });
});

describe("the ring's rules", () => {
    const ring = (variant: messages.RulesVariant) =>
        messages.rules("king-of-the-hill", "en", { ring: true, ...variant });

    it("say only what the ring does this game", () => {
        expect(ring({ rounds: 3, shrinks: true, moves: true })).toBe(
            "Hold the ring: in it you score, and alone, triple. It shrinks and moves, and the end of each round counts double."
        );
        expect(ring({ rounds: 3, shrinks: false, moves: true })).toContain(" It moves, and ");
        expect(ring({ rounds: 3, shrinks: true, moves: false })).toContain(" It shrinks, and ");
        expect(ring({ rounds: 3, shrinks: false, moves: false })).toBe(
            "Hold the ring: in it you score, and alone, triple. The end of each round counts double."
        );
    });

    it("speak of one end when there is one round", () => {
        expect(ring({ rounds: 1, shrinks: false, moves: false })).toBe(
            "Hold the ring: in it you score, and alone, triple. The end counts double."
        );
        expect(messages.rules("king-of-the-hill", "es", { ring: true, rounds: 1 })).toBe(
            "Aguanta en el ring: dentro sumas, y a solas, el triple. El final puntúa doble."
        );
    });

    it("count time in it on the event's own score", () => {
        expect(hill.scoreLines({ x: 0, y: 64, z: 0 }, 3, 1).at(-2)).toContain("add @s pe_score 1");
        expect(hill.INSIDE_SCORE).toBe("pe_kin");
    });
});
