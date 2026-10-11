/**
 * Tug of war: the pulls counted fairly and capped, the marker moved toward
 * the team pulling harder, the win at a line or on time, a platform with no
 * bed or anchor in it whose teardown takes everything it put down, and a pool
 * under each pen that the losers drop into.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as tug from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tug-of-war";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tug-of-war-messages";

const SITE = { x: 300, z: -120 };
const Y = 100;
const LENGTHS = [6, 10, 16];

const bare = (id: string) => id.replace(/\[.*$/, "");
const inside = (box: ReturnType<typeof tug.arenaBox>, at: { x: number; y: number; z: number }) =>
    at.x >= box.x1 &&
    at.x <= box.x2 &&
    at.y >= box.y1 &&
    at.y <= box.y2 &&
    at.z >= box.z1 &&
    at.z <= box.z2;

describe("counting pulls", () => {
    it("counts what rose, at most what a fast hand does in the time since", () => {
        expect(tug.capPulls(3, 0.5)).toBe(3);
        expect(tug.capPulls(100, 0.5)).toBe(tug.CAP_PER_SECOND / 2);
        expect(tug.capPulls(100, 2)).toBe(tug.CAP_PER_SECOND * 2);
        expect(tug.capPulls(0, 1)).toBe(0);
        expect(tug.capPulls(-4, 1)).toBe(0);
        expect(tug.capPulls(Number.NaN, 1)).toBe(0);
        // A first look after a restart has no time behind it: nothing counts.
        expect(tug.capPulls(5, 0)).toBe(0);
        // A long stall never banks more than a few seconds of clicking.
        expect(tug.capPulls(1000, 60)).toBe(tug.CAP_PER_SECOND * 5);
    });

    it("keys the capped pulls by lower-case name and leaves out who pulled nothing", () => {
        const counted = tug.countPulls(
            new Map([
                ["Alice", 2],
                ["Macro", 500],
                ["Idle", 0]
            ]),
            1
        );
        expect([...counted]).toEqual([
            ["alice", 2],
            ["macro", tug.CAP_PER_SECOND]
        ]);
    });

    it("averages a team over who is on, so the smaller side is not behind", () => {
        expect(tug.teamPull([4, 4, 4])).toBe(4);
        expect(tug.teamPull([4, 4])).toBe(4);
        expect(tug.teamPull([])).toBe(0);
        expect(tug.teamPull([8, 0])).toBe(4);
    });

    it("counts uses of the rod with a statistic criterion the server accepts", () => {
        expect(tug.SETUP).toContain(`scoreboard objectives add ${tug.PULLS} minecraft.used:minecraft.carrot_on_a_stick`);
    });
});

describe("moving the marker", () => {
    it("moves toward the team pulling harder, and not at all when they pull alike", () => {
        expect(tug.move(0, 5, 5, 10)).toBe(0);
        expect(tug.move(0, 8, 0, 10)).toBeCloseTo(-8 * tug.STEP);
        expect(tug.move(0, 0, 8, 10)).toBeCloseTo(8 * tug.STEP);
        expect(tug.move(2, 3, 1, 10)).toBeCloseTo(2 - 2 * tug.STEP);
    });

    it("never goes past either line", () => {
        expect(tug.move(-9.9, 8, 0, 10)).toBe(-10);
        expect(tug.move(9.9, 0, 8, 10)).toBe(10);
    });

    it("takes a team pulling flat out against nobody a fair while to win", () => {
        let position = 0;
        let looks = 0;
        while (tug.crossed(position, tug.DEFAULT_LENGTH) === null) {
            position = tug.move(position, tug.capPulls(99, 0.5), 0, tug.DEFAULT_LENGTH);
            looks += 1;
        }
        expect(tug.crossed(position, tug.DEFAULT_LENGTH)).toBe(0);
        // Ten seconds or more at the cap, half a second a look.
        expect(looks / 2).toBeGreaterThanOrEqual(10);
    });
});

describe("who wins", () => {
    it("is the team whose line the marker reached", () => {
        expect(tug.crossed(-10, 10)).toBe(0);
        expect(tug.crossed(10, 10)).toBe(1);
        expect(tug.crossed(9.99, 10)).toBeNull();
        expect(tug.crossed(0, 10)).toBeNull();
    });

    it("on time, the team it is nearer, and nobody exactly in the middle", () => {
        expect(tug.leader(-0.1)).toBe(0);
        expect(tug.leader(0.1)).toBe(1);
        expect(tug.leader(0)).toBeNull();
    });

    it("scores the winners by their pulls and the losers nothing; a draw keeps everybody's", () => {
        const entrants = [
            { name: "Red1", side: 0 },
            { name: "Blue1", side: 1 },
            { name: "Red2", side: 0 }
        ];
        const points = { Red1: 40, Blue1: 90, Red2: 12 };
        expect(tug.scoresOf(entrants, points, 0)).toEqual(
            new Map([
                ["Red1", 40],
                ["Blue1", 0],
                ["Red2", 12]
            ])
        );
        expect(tug.scoresOf(entrants, points, null).get("Blue1")).toBe(90);
    });

    it("reads a state written before as it stands, and a broken one as the start", () => {
        expect(tug.stateOf({ position: 3.5, wonBy: 1, wonAt: 5 })).toMatchObject({
            position: 3.5,
            wonBy: 1,
            wonAt: 5,
            timeUp: false
        });
        expect(tug.stateOf({ wonBy: 7 })).toEqual(tug.stateOf(undefined));
    });

    it("says who won in both languages, and a draw", () => {
        for (const language of ["en", "es"] as const) {
            expect(said.result(0, language)).toMatch(/Red|Rojo/);
            expect(said.result(null, language)).toMatch(/draw|empate/);
            expect(said.gauge(0, 10)).toContain("#");
        }
    });
});

describe("the platform", () => {
    it("puts no bed, anchor or anything that sets a spawn point anywhere", () => {
        for (const length of LENGTHS) {
            const box = tug.arenaBox(SITE, Y, length);
            const ids = [
                ...tug.arenaFills(box, length).map((one) => one.block),
                ...tug.ARENA_BLOCKS
            ];
            for (const id of ids) expect(id).not.toMatch(/_bed$|respawn_anchor/);
        }
    });

    it("builds everything inside its box, the marker last at the center", () => {
        for (const length of LENGTHS) {
            const box = tug.arenaBox(SITE, Y, length);
            const fills = tug.arenaFills(box, length);
            for (const fill of fills) {
                expect(inside(box, { x: fill.box.x1, y: fill.box.y1, z: fill.box.z1 })).toBe(true);
                expect(inside(box, { x: fill.box.x2, y: fill.box.y2, z: fill.box.z2 })).toBe(true);
            }
            const last = fills.at(-1)!;
            expect(last.block).toBe(tug.MARKER);
            const at = tug.markerAt(box, 0);
            expect(last.box).toEqual({
                x1: at.x,
                y1: at.y,
                z1: at.z,
                x2: at.x,
                y2: at.y,
                z2: at.z
            });
            expect(arena.volume(box)).toBeLessThanOrEqual(arena.VOLUME_MAX * 4);
        }
    });

    it("takes down everything it put down, the marker's moves and its kit included", () => {
        for (const length of LENGTHS) {
            const box = tug.arenaBox(SITE, Y, length);
            const placed = new Set(tug.arenaFills(box, length).map((one) => bare(one.block)));
            for (const line of tug.markerLines(box, length, length / 2)) {
                const id = /\b(?:setblock(?: -?\d+){3}|fill(?: -?\d+){6}) (minecraft:[a-z_]+)/.exec(
                    line
                );
                if (id) placed.add(id[1]!);
            }
            const taken = new Set(arena.withDecayed(tug.ARENA_BLOCKS));
            expect([...placed].filter((id) => !taken.has(id))).toEqual([]);
            expect(gameOf("tug-of-war")!.blocks({} as never, box)).toEqual([...tug.ARENA_BLOCKS]);
        }
    });

    it("takes the water down before the walls that hold it", () => {
        const order = tug.ARENA_BLOCKS;
        expect(order.indexOf("minecraft:water")).toBeLessThan(
            order.indexOf("minecraft:stone_bricks")
        );
        expect(order[0]).toBe(tug.MARKER);
    });

    it("opens only the losers' floor, over a pool deep enough to land in", () => {
        for (const length of LENGTHS) {
            const box = tug.arenaBox(SITE, Y, length);
            const fills = tug.arenaFills(box, length);
            for (const side of [0, 1]) {
                const floor = tug.penFloor(box, length, side);
                const [line] = tug.openLines(box, length, side);
                expect(line).toContain(
                    `fill ${floor.x1} ${floor.y1} ${floor.z1} ${floor.x2} ${floor.y2} ${floor.z2} minecraft:air replace ${tug.PEN_FLOOR}`
                );
                const pool = fills.find(
                    (one) =>
                        one.block === "minecraft:water" &&
                        one.box.x1 === floor.x1 &&
                        one.box.x2 === floor.x2
                )!;
                expect(pool.box.z1).toBe(floor.z1);
                expect(pool.box.z2).toBe(floor.z2);
                expect(pool.box.y2 - pool.box.y1 + 1).toBeGreaterThanOrEqual(2);
                expect(floor.y1 - pool.box.y2).toBeLessThan(23);
            }
        }
    });
});

describe("where the teams stand", () => {
    it("puts every player of a side in their own pen, apart, facing the other team", () => {
        for (const length of LENGTHS) {
            const box = tug.arenaBox(SITE, Y, length);
            for (const side of [0, 1]) {
                const seen = new Set<string>();
                for (let index = 0; index < tug.MOST / 2; index += 1) {
                    const spot = tug.startSpot(box, length, side, index);
                    const at = { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 };
                    expect(tug.inPen(box, length, side, at)).toBe(true);
                    expect(tug.inPen(box, length, 1 - side, at)).toBe(false);
                    // Never on the rope.
                    expect(spot.z).not.toBe(tug.markerAt(box, 0).z);
                    expect(spot.yaw).toBe(side === 0 ? -90 : 90);
                    seen.add(`${spot.x},${spot.z}`);
                }
                expect(seen.size).toBe(tug.MOST / 2);
            }
            // Out of reach of each other: nobody can punch across.
            const red = tug.startSpot(box, length, 0, 0);
            const blue = tug.startSpot(box, length, 1, 0);
            expect(blue.x - red.x).toBeGreaterThan(10);
        }
    });

    it("splits who joins evenly between the two teams", () => {
        const game = gameOf("tug-of-war")!;
        const run = {} as never;
        const sides = Array.from({ length: 7 }, (_, index) => game.side(run, index));
        expect(sides.filter((side) => side === 0).length).toBe(4);
        expect(sides.filter((side) => side === 1).length).toBe(3);
        expect(game.teams).toBe(2);
    });
});

describe("the catalog", () => {
    it("is a sky arena with a rope length that defaults and is bounded", () => {
        const preset = catalog.newPreset("tug-of-war", "tug");
        expect(catalog.playsInArena(preset)).toBe(true);
        expect(catalog.heldWhere(preset)).toBe("sky");
        expect(catalog.needsPvp(preset)).toBe(false);
        expect((preset.options as catalog.EventOptions<"tug-of-war">).ropeLength).toBe(10);
        const bad = { ...preset, options: { ...preset.options, ropeLength: 30 } };
        expect(catalog.presetSchema.safeParse(bad).success).toBe(false);
    });
});
