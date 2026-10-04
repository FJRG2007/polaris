/**
 * Hide and seek's house and rules, pure: the house drawn from the run's id and
 * checked against its rules over thousands of seeds, what it is built of, the
 * cage, the seekers drawn, a find, the scores and what players read.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const SEEDS = 1000;
const box = hs.hallBox({ x: 100, z: -40 }, 100);

describe("hide and seek's house", () => {
    it("keeps every rule over thousands of seeds, never falling back to an empty house", () => {
        let bare = 0;
        const counts: Record<hs.PieceKind, number> = {
            wall: 0,
            hedge: 0,
            crate: 0,
            stack: 0,
            closet: 0,
            bush: 0,
            pit: 0
        };
        const corners = new Set<string>();
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const layout = hs.layoutFor(`run-${seed}`);
            expect(hs.layoutProblems(layout)).toEqual([]);
            if (layout.bare) bare += 1;
            for (const [kind, count] of Object.entries(hs.hidingPlaces(layout)))
                counts[kind as hs.PieceKind] += count;
            corners.add(`${layout.flipX},${layout.flipZ}`);
            expect(layout.doorways).toHaveLength(12);
            expect(layout.lofts).toHaveLength(2);
        }
        expect(bare).toBe(0);
        // Real places to hide in every house: closets, hatches and bushes,
        // besides cover to crouch behind.
        expect(counts.closet / SEEDS).toBeGreaterThan(6);
        expect(counts.pit / SEEDS).toBeGreaterThan(5);
        expect(counts.bush / SEEDS).toBeGreaterThan(3);
        for (const kind of ["wall", "hedge", "crate", "stack"] as const)
            expect(counts[kind] / SEEDS).toBeGreaterThan(1);
        expect(corners.size).toBe(4);
    }, 120_000);

    it("is the same house for the same run, and another for another", () => {
        expect(hs.layoutFor("abc")).toEqual(hs.layoutFor("abc"));
        expect(hs.layoutFor("abc")).not.toEqual(hs.layoutFor("abd"));
    });

    it("finds a corner sealed off, pieces touching, a doorway blocked, a dark corner and a closet off its wall", () => {
        const layout = hs.layoutFor("run-1");
        const piece = (over: Partial<hs.Piece>): hs.Piece => ({
            kind: "wall",
            x: 34,
            z: 34,
            level: 1,
            w: 1,
            d: 1,
            h: 3,
            ...over
        });
        const empty = { ...layout, pieces: [] };
        expect(hs.layoutProblems(empty)).toEqual([]);
        // Two walls closing a room's corner off from the rest - the corner of
        // whichever corner room has no loft against those walls.
        const free = [
            { x: 1, z: 1 },
            { x: 37, z: 1 },
            { x: 1, z: 37 },
            { x: 37, z: 37 }
        ].find(
            (corner) =>
                !layout.lofts.some(
                    (loft) =>
                        corner.x + 1 >= loft.x1 &&
                        corner.x <= loft.x2 &&
                        corner.z + 1 >= loft.z1 &&
                        corner.z <= loft.z2
                )
        )!;
        const lowX = free.x === 1;
        const lowZ = free.z === 1;
        const sealed = [
            piece({ x: lowX ? 1 : 37, z: lowZ ? 3 : 37, w: 3 }),
            piece({ x: lowX ? 3 : 37, z: lowZ ? 1 : 37, d: 2 })
        ];
        const problems = hs.layoutProblems({ ...empty, pieces: sealed });
        expect(problems.join(" ")).toMatch(/cannot be reached/);
        expect(problems).toContain("pieces 0 and 1 touch");
        const door = layout.doorways[0]!;
        const inDoor =
            door.across === "x"
                ? piece({ x: door.line + 1, z: door.at })
                : piece({ x: door.at, z: door.line + 1 });
        expect(hs.layoutProblems({ ...empty, pieces: [inDoor] })).toContain(
            "piece 0 is in the way of a doorway, a ladder, a lamp or the cage"
        );
        expect(hs.layoutProblems({ ...empty, pieces: [piece({ x: 12, w: 3 })] })).toContain(
            "piece 0 is not inside one room"
        );
        expect(
            hs.layoutProblems({
                ...empty,
                pieces: [piece({ kind: "closet", x: 30, z: 30, w: 2, d: 3, side: "west" })]
            })
        ).toContain("closet 0 is not against a wall");
        expect(hs.layoutProblems({ ...empty, pieces: [piece({ level: 3 })] })).toContain(
            "piece 0 floats"
        );
    });

    it("lights every place to stand, so no monster spawns in the house", () => {
        // A wall boxing a corner in leaves it unlit as well as out of reach.
        const layout = hs.layoutFor("run-7");
        expect(hs.layoutProblems(layout)).toEqual([]);
        expect(hs.layoutProblems({ ...layout, pieces: [], lofts: [] }).join(" ")).not.toMatch(
            /dark/
        );
    });
});

describe("hide and seek's house in the world", () => {
    const layout = hs.layoutFor("run-1");
    const fills = hs.hallFills(box, layout);

    it("is built only into air inside its box, its floor last as the proof", () => {
        for (const one of fills) {
            expect(arena.fillKeep(one.box, one.block)).toMatch(/ keep$/);
            expect(one.box.x1).toBeGreaterThanOrEqual(box.x1);
            expect(one.box.x2).toBeLessThanOrEqual(box.x2);
            expect(one.box.y1).toBeGreaterThanOrEqual(box.y1);
            expect(one.box.y2).toBeLessThanOrEqual(box.y2);
            expect(one.box.z1).toBeGreaterThanOrEqual(box.z1);
            expect(one.box.z2).toBeLessThanOrEqual(box.z2);
            expect(hs.HALL_BLOCKS).toContain(one.block.replace(/\[.*$/, ""));
            // One fill never takes more than a server allows.
            const { x1, y1, z1, x2, y2, z2 } = one.box;
            expect((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1)).toBeLessThanOrEqual(32_768);
        }
        const last = fills.at(-1)!;
        expect(last.block).toBe("minecraft:smooth_stone");
        expect(last.box.y1).toBe(box.y1 + 3);
        // Leaves that never wither; doors in two halves; hatches shut over
        // their pits; ladders turned with the house.
        expect(fills.some((one) => one.block === "minecraft:oak_leaves[persistent=true]")).toBe(
            true
        );
        expect(fills.some((one) => /^minecraft:oak_door\[.*half=lower/.test(one.block))).toBe(true);
        expect(fills.some((one) => /^minecraft:oak_door\[.*half=upper/.test(one.block))).toBe(true);
        expect(
            fills.some((one) => /^minecraft:spruce_trapdoor\[.*open=false/.test(one.block))
        ).toBe(true);
        // The ladders, doors and hatches go in before what holds them.
        const firstOther = fills.findIndex(
            (one, index) =>
                index > 5 && !/^minecraft:(ladder|oak_door|spruce_trapdoor)\b/.test(one.block)
        );
        expect(
            fills
                .slice(firstOther)
                .some((one) => /^minecraft:(ladder|oak_door|spruce_trapdoor)\b/.test(one.block))
        ).toBe(false);
        const flipped = hs.hallFills(box, { ...layout, flipX: true, flipZ: true });
        const turned = (fill: { block: string }) =>
            fill.block.replace(/facing=(\w+)/, (_, way: string) => `facing=${way}`);
        expect(flipped.map(turned)).not.toEqual(fills.map(turned));
    });

    it("comes down with its ladders, doors and hatches before what holds them", () => {
        const lines = arena.teardown({ box, blocks: [...hs.HALL_BLOCKS] });
        const index = (block: string) =>
            lines.findIndex((line) => line.endsWith(`replace minecraft:${block}`));
        for (const hung of ["ladder", "oak_door", "spruce_trapdoor"])
            for (const holder of [
                "spruce_log",
                "birch_planks",
                "stone",
                "smooth_stone",
                "oak_planks"
            ]) {
                expect(index(hung)).toBeGreaterThanOrEqual(0);
                expect(index(hung)).toBeLessThan(index(holder));
            }
    });

    it("takes the cage down by its barrier alone, inside its own box", () => {
        const cage = hs.cageBox(box, layout);
        expect(cage.x2 - cage.x1).toBe(4);
        expect(cage.y1).toBe(box.y1 + 4);
        expect(hs.cageDown(box, layout)).toBe(
            `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace minecraft:barrier`
        );
        // A run built before this design has its cage elsewhere: every barrier
        // over its floor comes down, so an update never leaves seekers shut in.
        expect(hs.cageDown(box, layout, hs.DESIGN - 1)).toBe(
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1 + 1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace minecraft:barrier`
        );
        // The seekers wait inside it, the hiders round it.
        for (let index = 0; index < 3; index += 1) {
            const spot = hs.seekerSpot(box, layout, index);
            expect(spot.x).toBeGreaterThan(cage.x1);
            expect(spot.x).toBeLessThan(cage.x2);
            expect(spot.z).toBeGreaterThan(cage.z1);
            expect(spot.z).toBeLessThan(cage.z2);
        }
        const starts = new Set<string>();
        for (let index = 0; index < hs.MOST; index += 1) {
            const spot = hs.hiderSpot(box, layout, index);
            expect(
                spot.x < cage.x1 || spot.x > cage.x2 || spot.z < cage.z1 || spot.z > cage.z2
            ).toBe(true);
            expect(spot.y).toBe(box.y1 + 4);
            starts.add(`${spot.x},${spot.z}`);
        }
        expect(starts.size).toBe(hs.MOST);
    });

    it("starts a run built by the first design in that hall's own cage", () => {
        // The first design's hall: 27 across, its cage round 15 (11 mirrored),
        // its floor a block over the barrier and the cage's lid four over that.
        const first = { x1: 0, y1: 100, z1: 0, x2: 26, y2: 110, z2: 26 };
        const design = hs.DESIGN - 1;
        const tests = hs.mirrorTests(first, design);
        expect(tests).toHaveLength(4);
        for (const { mirror, line } of tests) {
            const cx = mirror.flipX ? 11 : 15;
            const cz = mirror.flipZ ? 11 : 15;
            expect(line).toBe(
                `execute in minecraft:overworld if block ${cx} 105 ${cz} minecraft:barrier`
            );
            for (let index = 0; index < 3; index += 1) {
                const spot = hs.seekerSpot(first, mirror, index, design);
                expect(Math.abs(spot.x - cx)).toBeLessThan(2);
                expect(spot.z).toBe(cz);
                expect(spot.y).toBe(102);
            }
            for (let index = 0; index < hs.MOST; index += 1) {
                const spot = hs.hiderSpot(first, mirror, index, design);
                expect(Math.max(Math.abs(spot.x - cx), Math.abs(spot.z - cz))).toBe(3);
                expect(spot.y).toBe(102);
            }
        }
    });
});
describe("hide and seek's rules", () => {
    const names = ["Ana", "Ben", "Cy", "Dee"];

    it("draws the seekers from the run's id, never everybody", () => {
        const two = hs.seekersFor("run-1", names, 2);
        expect(two).toHaveLength(2);
        expect(hs.seekersFor("run-1", [...names].reverse(), 2)).toEqual(two);
        expect(hs.seekersFor("run-1", ["Ana", "Ben"], 3)).toHaveLength(1);
    });

    it("finds a hider only beside a seeker who struck", () => {
        const at = { x: 0, y: 100, z: 0 };
        expect(hs.foundBy(at, [{ name: "Ben", x: 2, y: 100, z: 0 }])).toBe("Ben");
        expect(hs.foundBy(at, [{ name: "Ben", x: 9, y: 100, z: 0 }])).toBeNull();
        expect(
            hs.foundBy(at, [
                { name: "Ben", x: 3, y: 100, z: 0 },
                { name: "Cy", x: 1, y: 100, z: 1 }
            ])
        ).toBe("Cy");
    });

    it("scores a point a second hidden and a fixed number a find", () => {
        const state = hs.stateSchema.parse({
            seekers: ["Ben"],
            finds: [
                { hider: "Ana", by: "Ben", at: 1 },
                { hider: "Cy", by: "Ana", at: 2 }
            ],
            hidden: { Ana: 61_500, Cy: 120_000, Dee: 300_000 }
        });
        expect(Object.fromEntries(hs.scoresOf(state, names))).toEqual({
            Ana: 61 + hs.FIND_POINTS,
            Ben: hs.FIND_POINTS,
            Cy: 120,
            Dee: 300
        });
        expect(hs.seeks(state, "cy")).toBe(true);
        expect(hs.seeks(state, "Dee")).toBe(false);
        expect(hs.stateOf({ design: 1 })).toBeNull();
    });

    it("hides each side's names from the other, and keeps the seekers blind and still while they wait", () => {
        const lines = hs.setupLines(["Seekers", "Hiders"]);
        expect(lines).toContain("team modify pe_hs_seek nametagVisibility hideForOtherTeams");
        expect(lines).toContain("team modify pe_hs_hide friendlyFire false");
        expect(hs.waitingLines("Ben")).toContain("effect give Ben minecraft:blindness 3 0 true");
        expect(hs.hiderLine("Ana")).toBe("effect give Ana minecraft:weakness 3 100 true");
        expect(hs.joinSide("Ana", true)).toContain(
            "execute if entity @a[name=Ana,team=pe_hs_hide] run team join pe_hs_seek Ana"
        );
    });
});

describe("what hide and seek says", () => {
    const LONG = "Maximilian_1234";
    for (const language of ["en", "es"] as const) {
        it(`fits one command in ${language}`, () => {
            const lines = [
                said.found(LONG, LONG, 11, language),
                said.hiddenBar(3599, 11, language),
                said.seekBar(11, language),
                said.waitBar(60, language),
                said.bar(11, "59:59", language),
                said.summary(11, 11, language),
                said.hideSubtitle(60, language),
                said.seekSubtitle(60, language)
            ].map((line) => commands.say(messages.tag(language) + line));
            for (const line of lines)
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            expect(said.hideTitle(language)).not.toBe(
                said.hideTitle(language === "en" ? "es" : "en")
            );
        });
    }
});
