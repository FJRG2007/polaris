import { createHash } from "node:crypto";
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
                const add = / as @a\[[^\]]+\] run scoreboard players add @s pe_score (\d+)$/.exec(
                    line
                );
                if (!add) continue;
                if (line.includes("matches 1 ") && inRing !== 1) continue;
                for (const name of names)
                    scores.set(name, (scores.get(name) ?? 0) + Number(add[1]));
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
        expect(hill.startSpots(place, 2, 3).every((spot) => spot.x === 100 && spot.z === -20)).toBe(
            true
        );
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

describe("the king of the ring's own look", () => {
    const radius = 10;
    const half = radius + hill.MARGIN;
    const at = (one: { box: { x1: number; y1: number; z1: number } }) =>
        `${one.box.x1 - place.x},${one.box.y1 - place.y},${one.box.z1 - place.z}`;

    it("edges the floor in sculk, burns soul fire on its corners and sets a skull in each side looking in", () => {
        const decor = hill.platformDecor(place, radius, hill.DEATH);
        const blockAt = new Map(decor.map((one) => [at(one), one.block]));
        for (const [dx, dz] of [
            [-half, -half],
            [half, -half],
            [-half, half],
            [half, half]
        ] as const) {
            expect(blockAt.get(`${dx},0,${dz}`)).toBe(hill.DEATH.corner);
            expect(blockAt.get(`${dx},1,${dz}`)).toBe("minecraft:soul_campfire");
        }
        expect(blockAt.get(`0,1,${-half}`)).toBe("minecraft:wither_skeleton_skull[rotation=0]");
        expect(blockAt.get(`0,1,${half}`)).toBe("minecraft:wither_skeleton_skull[rotation=8]");
        expect(blockAt.get(`${-half},1,0`)).toBe("minecraft:wither_skeleton_skull[rotation=12]");
        expect(blockAt.get(`${half},1,0`)).toBe("minecraft:wither_skeleton_skull[rotation=4]");
        expect(decor.filter((one) => one.block === hill.DEATH.edge)).toHaveLength(4);
        expect(decor.some((one) => one.block === hill.DEATH.ring)).toBe(true);
        // Everything it builds is on its list, so it all comes down again.
        const listed = new Set(hill.lookBlocks(hill.DEATH));
        for (const one of decor) expect(listed.has(one.block.replace(/\[.*$/, ""))).toBe(true);
    });

    it("never draws the ring onto the sculk, wherever it drifts", () => {
        for (let seed = 0; seed < 40; seed += 1) {
            const settings = {
                seed: `look-${seed}`,
                radius,
                players: 6,
                rounds: 3,
                shrinks: true,
                moves: true
            };
            for (let ms = 0; ms <= 3 * 60_000; ms += 2_000) {
                const ring = hill.ringAt(settings, 3 * 60_000, ms);
                const center = hill.ringCenter(place, ring);
                for (const cell of hill.ringBlocks(center, ring.radius)) {
                    expect(Math.abs(cell.x - place.x)).toBeLessThan(half);
                    expect(Math.abs(cell.z - place.z)).toBeLessThan(half);
                }
            }
        }
    });

    it("redraws the ring in its own blocks, and keeps the plain one for a platform built before", () => {
        const floor = { ...place, y: place.y - 1 };
        const lines = hill.redrawLines(floor, radius, floor, 6, hill.DEATH);
        expect(lines[0]).toMatch(/ minecraft:deepslate_tiles replace minecraft:ochre_froglight$/);
        expect(
            lines
                .slice(1)
                .every((line) =>
                    line.endsWith(" minecraft:ochre_froglight replace minecraft:deepslate_tiles")
                )
        ).toBe(true);
        expect(hill.lookOf([...hill.lookBlocks(hill.DEATH), hill.FIRE])).toBe(hill.DEATH);
        expect(hill.lookOf([...hill.PLATFORM_BLOCKS, hill.FIRE])).toBe(hill.PLAIN);
        expect(hill.lookBlocks(hill.PLAIN)).toEqual([...hill.PLATFORM_BLOCKS]);
    });

    it("drifts souls and ash over it, and beats a heart through the double points only", () => {
        const calm = hill.ambientLines(place, radius, false);
        expect(calm.some((line) => line.includes("particle minecraft:sculk_soul"))).toBe(true);
        expect(calm.some((line) => line.includes("particle minecraft:ash"))).toBe(true);
        expect(calm.some((line) => line.includes("heartbeat"))).toBe(false);
        expect(
            hill
                .ambientLines(place, radius, true)
                .some((line) =>
                    line.includes(
                        "playsound minecraft:entity.warden.heartbeat ambient @a[tag=pe_arena]"
                    )
                )
        ).toBe(true);
    });
});
describe("the king of the ring's court", () => {
    const radius = 10;
    const half = radius + hill.MARGIN;
    const id = (block: string) => block.replace(/\[.*$/, "");
    const cells = (look: hill.Look, r = radius) =>
        hill.platformDecor(place, r, look).flatMap((one, order) => {
            const out: { x: number; y: number; z: number; block: string; order: number }[] = [];
            for (let x = one.box.x1; x <= one.box.x2; x += 1)
                for (let y = one.box.y1; y <= one.box.y2; y += 1)
                    for (let z = one.box.z1; z <= one.box.z2; z += 1)
                        out.push({
                            x: x - place.x,
                            y: y - place.y,
                            z: z - place.z,
                            block: one.block,
                            order
                        });
            return out;
        });
    /** Blocks nobody can stand on or be stopped by. */
    const PASSABLE = new Set([
        "minecraft:red_banner",
        "minecraft:red_wall_banner",
        "minecraft:light"
    ]);
    const HANGING = new Set([
        "minecraft:red_banner",
        "minecraft:red_wall_banner",
        "minecraft:soul_lantern",
        "minecraft:end_rod",
        "minecraft:red_carpet"
    ]);

    it("keeps the platforms built before it exactly as they were drawn", () => {
        // Fingerprints taken before the court existed: a ring still standing
        // in an old look is redrawn, lit and taken down as it was built.
        const hash = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
        const before: Record<string, string[]> = {
            "PLAIN 4": [
                "60fc3cc5257d8770",
                "a60e771a028afafc",
                "9e841a66eeac507f",
                "1aa02f6c1f2a50e0",
                "80f02a83c1e96aab"
            ],
            "PLAIN 10": [
                "9e9be4fd6e622b6b",
                "a60e771a028afafc",
                "6f7c6b5dd35a9b4e",
                "691fa4de23eae763",
                "849a85b70ea88a7d"
            ],
            "PLAIN 16": [
                "eb0e297c73edddc0",
                "a60e771a028afafc",
                "234ac5f9b0a1dcb3",
                "e1a02c1695afe416",
                "d58bddab796f9e7f"
            ],
            "DEATH 4": [
                "92e482f0e2f47e31",
                "acac932a1b6a2f11",
                "9e841a66eeac507f",
                "1aa02f6c1f2a50e0",
                "4abd558da1891751"
            ],
            "DEATH 10": [
                "69a5c353bfabf3ed",
                "acac932a1b6a2f11",
                "6f7c6b5dd35a9b4e",
                "691fa4de23eae763",
                "4d8cf81e285629ca"
            ],
            "DEATH 16": [
                "609d261fdaa83eb9",
                "acac932a1b6a2f11",
                "234ac5f9b0a1dcb3",
                "e1a02c1695afe416",
                "528e560b6a3b3bc6"
            ]
        };
        for (const [key, prints] of Object.entries(before)) {
            const [name, size] = key.split(" ") as ["PLAIN" | "DEATH", string];
            const r = Number(size);
            const look = hill[name];
            expect([
                hash(hill.platformDecor(place, r, look)),
                hash(hill.lookBlocks(look)),
                hash(hill.proofBox(place, r)),
                hash(hill.platformBox(place, r)),
                hash(hill.redrawLines(place, r, place, 6, look))
            ]).toEqual(prints);
        }
        expect(hash(hill.ambientLines(place, 10, false))).toBe("956905e1924e9e11");
        expect(hash(hill.ambientLines(place, 10, true))).toBe("b90ed44bd7cee80f");
        expect(hill.lookOf([...hill.lookBlocks(hill.DEATH), hill.FIRE])).toBe(hill.DEATH);
        expect(hill.lookOf([...hill.lookBlocks(hill.ROYAL), hill.FIRE])).toBe(hill.ROYAL);
    });

    it("builds every block it lists, and only those - and nothing anybody sleeps or respawns on", () => {
        for (const r of [3, 10, 20]) {
            // The fighting floor is filled round the rest (`buildPlatform`).
            const built = new Set([
                ...cells(hill.ROYAL, r).map((one) => id(one.block)),
                hill.ROYAL.floor
            ]);
            const listed = hill.lookBlocks(hill.ROYAL);
            expect([...built].sort()).toEqual([...listed].sort());
            expect(listed.some((block) => /_bed$|respawn_anchor/.test(block))).toBe(false);
        }
    });

    it("stands nothing in the air a knocked-off player falls through, and nothing on the floor to hide behind", () => {
        for (const r of [3, 10, 20]) {
            const h = r + hill.MARGIN;
            for (const one of cells(hill.ROYAL, r)) {
                const out = Math.max(Math.abs(one.x), Math.abs(one.z));
                // Past the edge and short of where a fall is brought back: only
                // what nobody can stand on or be stopped by.
                if (out > h && out <= h + 6)
                    expect(PASSABLE.has(id(one.block)), JSON.stringify(one)).toBe(true);
                // Over the fighting floor inside the edge: only the crown, far
                // over everybody's head.
                if (out < h && one.y > 0 && !PASSABLE.has(id(one.block)))
                    expect(one.y, JSON.stringify(one)).toBeGreaterThanOrEqual(8);
                // On the edge: the border, and only low markers over it.
                if (out === h && one.y > 0) {
                    expect(one.y).toBe(1);
                    expect(["minecraft:soul_lantern", "minecraft:red_banner"]).toContain(
                        id(one.block)
                    );
                }
            }
        }
    });

    it("keeps the ring's redraw off its border, its court and its crown", () => {
        for (const one of cells(hill.ROYAL)) {
            const out = Math.max(Math.abs(one.x), Math.abs(one.z));
            if (one.y === 0 && out === half) {
                expect(one.block).not.toBe(hill.ROYAL.floor);
                expect(one.block).not.toBe(hill.ROYAL.ring);
            }
            if (one.y === 0 && out < half) expect(one.block).toBe(hill.ROYAL.ring);
        }
        for (const line of hill.redrawLines(place, radius, place, 6, hill.ROYAL))
            expect(line).toMatch(
                / minecraft:(polished_blackstone replace minecraft:ochre_froglight|ochre_froglight replace minecraft:polished_blackstone)$/
            );
    });

    it("is proved empty and taken down whole: every block inside its proof, and what hangs on something taken first", () => {
        const step: Record<string, readonly [number, number, number]> = {
            north: [0, 0, 1],
            south: [0, 0, -1],
            east: [-1, 0, 0],
            west: [1, 0, 0]
        };
        const order = hill.lookBlocks(hill.ROYAL);
        for (const r of [3, 10, 20]) {
            const proof = hill.proofBox(place, r, hill.ROYAL);
            const all = cells(hill.ROYAL, r);
            for (const one of all) {
                const x = one.x + place.x;
                const y = one.y + place.y;
                const z = one.z + place.z;
                expect(x >= proof.x1 && x <= proof.x2 && y >= proof.y1 && y <= proof.y2).toBe(true);
                expect(z >= proof.z1 && z <= proof.z2).toBe(true);
            }
            expect(hill.footprint(r, hill.ROYAL)).toBe(proof.x2 - place.x);
            // Each block that needs something to hold it is built after it, and
            // its kind comes down before every kind that holds it.
            const at = new Map(all.map((one) => [`${one.x},${one.y},${one.z}`, one]));
            for (const one of all) {
                if (!HANGING.has(id(one.block))) continue;
                const facing = /facing=(\w+)/.exec(one.block)?.[1] ?? "";
                const [dx, dy, dz] = one.block.includes("hanging=true")
                    ? [0, 1, 0]
                    : id(one.block) === "minecraft:red_wall_banner"
                      ? step[facing]!
                      : [0, -1, 0];
                const holder = at.get(`${one.x + dx},${one.y + dy},${one.z + dz}`);
                expect(holder, JSON.stringify(one)).toBeDefined();
                expect(holder!.order).toBeLessThan(one.order);
                expect(order.indexOf(id(one.block))).toBeLessThan(order.indexOf(id(holder!.block)));
            }
        }
    });

    it("leaves no dark top a monster could spawn on", () => {
        for (const r of [3, 10, 20]) {
            const all = cells(hill.ROYAL, r);
            const LIGHTS = new Set([
                "minecraft:shroomlight",
                "minecraft:ochre_froglight",
                "minecraft:soul_lantern",
                "minecraft:end_rod",
                "minecraft:soul_campfire",
                "minecraft:light"
            ]);
            // Nothing spawns on these, however dark.
            const NO_SPAWN = /_stairs|_wall$|_banner|lantern|end_rod|carpet|campfire|chain|:light$/;
            const h = r + hill.MARGIN;
            const onFloor = (one: { x: number; y: number; z: number }) =>
                one.y === 0 && Math.max(Math.abs(one.x), Math.abs(one.z)) < h;
            const taken = new Set(all.map((one) => `${one.x},${one.y},${one.z}`));
            // The floor, filled round the rest, covers what lies under it.
            for (let x = -h; x <= h; x += 1)
                for (let z = -h; z <= h; z += 1) taken.add(`${x},0,${z}`);
            // Not the ring: it moves, and the floor goes back where it was.
            const lights = all.filter((one) => LIGHTS.has(id(one.block)) && !onFloor(one));
            for (const one of all) {
                if (NO_SPAWN.test(id(one.block)) || onFloor(one)) continue;
                if (taken.has(`${one.x},${one.y + 1},${one.z}`)) continue;
                // Block light falls off a level a block: well short of nought.
                const lit = lights.some(
                    (light) =>
                        Math.abs(light.x - one.x) +
                            Math.abs(light.y - one.y - 1) +
                            Math.abs(light.z - one.z) <=
                        9
                );
                expect(lit, JSON.stringify(one)).toBe(true);
            }
            // And the fighting floor, filled round it all: every block of it.
            for (let x = -h; x <= h; x += 1)
                for (let z = -h; z <= h; z += 1) {
                    const lit = lights.some(
                        (light) =>
                            Math.abs(light.x - x) + Math.abs(light.y - 1) + Math.abs(light.z - z) <=
                            13
                    );
                    expect(lit, `${x},${z}`).toBe(true);
                }
        }
    });

    it("lets its crown and throne glitter over the souls and ash", () => {
        const lines = hill.ambientLines(place, radius, false, hill.ROYAL);
        expect(lines.some((line) => line.includes("particle minecraft:sculk_soul"))).toBe(true);
        expect(lines.some((line) => line.includes("particle minecraft:end_rod"))).toBe(true);
        expect(lines.some((line) => line.includes("particle minecraft:wax_on"))).toBe(true);
    });
});
