/**
 * Hide and seek's house and rules, pure: the house drawn from the run's id and
 * checked against its rules over thousands of seeds, what it is built of, the
 * cage, the seekers drawn, a find, the scores and what players read.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as doors from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/secret-doors";
import * as pack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";
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
            pit: 0,
            secret: 0,
            steps: 0,
            perch: 0,
            rafter: 0
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
        // besides cover to crouch behind; places to climb up to, and secret
        // rooms.
        expect(counts.closet / SEEDS).toBeGreaterThan(5.5);
        expect(counts.pit / SEEDS).toBeGreaterThan(5);
        expect(counts.bush / SEEDS).toBeGreaterThan(3);
        for (const kind of ["wall", "hedge", "crate", "stack"] as const)
            expect(counts[kind] / SEEDS).toBeGreaterThan(1);
        expect(counts.secret / SEEDS).toBeGreaterThan(1.9);
        for (const kind of ["steps", "perch", "rafter"] as const)
            expect(counts[kind] / SEEDS).toBeGreaterThan(1.8);
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
        // The buttons, ladders, doors and hatches go in before what holds them.
        const hung = /^minecraft:(oak_button|ladder|oak_door|spruce_trapdoor)\b/;
        const firstOther = fills.findIndex((one, index) => index > 5 && !hung.test(one.block));
        expect(fills.slice(firstOther).some((one) => hung.test(one.block))).toBe(false);
        // A secret door is built open: its pistons unpowered and retracted,
        // and no power at all - only the data pack sets that.
        expect(
            fills.filter((one) =>
                /^minecraft:oak_button\[face=wall,facing=\w+,powered=false\]$/.test(one.block)
            )
        ).toHaveLength(2 * hs.hidingPlaces(layout).secret);
        expect(
            fills
                .filter((one) => one.block.startsWith("minecraft:sticky_piston"))
                .map((one) => one.block)
                .sort()
        ).toEqual(
            [
                ...Array(hs.hidingPlaces(layout).secret).fill(
                    "minecraft:sticky_piston[facing=down,extended=false]"
                ),
                ...Array(hs.hidingPlaces(layout).secret).fill(
                    "minecraft:sticky_piston[facing=up,extended=false]"
                )
            ].sort()
        );
        expect(fills.some((one) => /redstone|piston_head/.test(one.block))).toBe(false);
        const flipped = hs.hallFills(box, { ...layout, flipX: true, flipZ: true });
        const turned = (fill: { block: string }) =>
            fill.block.replace(/facing=(\w+)/, (_, way: string) => `facing=${way}`);
        expect(flipped.map(turned)).not.toEqual(fills.map(turned));
    });

    it("comes down with its ladders, doors and hatches before what holds them", () => {
        const lines = arena.teardown({ box, blocks: [...hs.HALL_BLOCKS] });
        const index = (block: string) =>
            lines.findIndex((line) => line.endsWith(`replace minecraft:${block}`));
        for (const hung of ["oak_button", "ladder", "oak_door", "spruce_trapdoor"])
            for (const holder of [
                "spruce_log",
                "birch_planks",
                "stone",
                "smooth_stone",
                "oak_planks",
                "bookshelf",
                "spruce_planks"
            ]) {
                expect(index(hung)).toBeGreaterThanOrEqual(0);
                expect(index(hung)).toBeLessThan(index(holder));
            }
        // A secret door's pistons before their power, so nothing moves as it
        // comes down; and whatever a piston might be holding or moving after.
        for (const after of ["redstone_block", "bookshelf", "piston_head", "moving_piston"])
            expect(index("sticky_piston")).toBeLessThan(index(after));
    });

    it("takes the cage down by its barrier alone, inside its own box", () => {
        const cage = hs.cageBox(box, layout);
        expect(cage.x2 - cage.x1).toBe(4);
        expect(cage.y1).toBe(box.y1 + 4);
        expect(hs.cageDown(box, layout)).toBe(
            `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace minecraft:barrier`
        );
        // A run built before the house has its cage elsewhere: every barrier
        // over its floor comes down, so an update never leaves seekers shut in.
        expect(hs.cageDown(box, layout, 1)).toBe(
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1 + 1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace minecraft:barrier`
        );
        // One built by the house's first design has it where this one does.
        expect(hs.cageDown(box, hs.layoutFor("run-1", 2), 2)).toBe(hs.cageDown(box, layout));
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
        const design = 1;
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
describe("hide and seek's climbs and secret rooms", () => {
    const FEATURES = ["secret", "steps", "perch", "rafter"];
    const layout = hs.layoutFor("run-1");
    const features = layout.pieces.filter((piece) => FEATURES.includes(piece.kind));
    const roomOf = (at: number) => (at < 13 ? 0 : at < 27 ? 1 : 2);
    /** How many places to stand the walk reaches inside a piece, at one height. */
    const reachedIn = (piece: hs.Piece, feet: number) => {
        const reached = hs.reachability(layout);
        let count = 0;
        for (let x = piece.x; x < piece.x + piece.w; x += 1)
            for (let z = piece.z; z < piece.z + piece.d; z += 1)
                if (reached(x, feet, z)) count += 1;
        return count;
    };

    it("spreads them one to a room, and the walk reaches every place on them and in them", () => {
        expect(hs.layoutProblems(layout)).toEqual([]);
        expect(features.map((piece) => piece.kind).sort()).toEqual([
            "perch",
            "perch",
            "rafter",
            "rafter",
            "secret",
            "secret",
            "steps",
            "steps"
        ]);
        expect(new Set(features.map((one) => `${roomOf(one.x)},${roomOf(one.z)}`)).size).toBe(
            features.length
        );
        for (const piece of features)
            switch (piece.kind) {
                // The hidden room (two by three), its doorway and the alcove in
                // front: in through the door, the only way.
                case "secret":
                    expect(reachedIn(piece, 1)).toBe(6 + 1 + 3);
                    break;
                // The wardrobe's top, two by two, four up: by the barrels.
                case "steps":
                    expect(reachedIn(piece, 5)).toBe(4);
                    expect(reachedIn(piece, 2) + reachedIn(piece, 3) + reachedIn(piece, 4)).toBe(3);
                    break;
                // The crow's nest, two by two at the lofts' height: by its ladder.
                case "perch":
                    expect(reachedIn(piece, 5)).toBe(4);
                    break;
                // The whole beam, six long, five up: by the ladder up the wall.
                default:
                    expect(reachedIn(piece, 6)).toBe(6);
            }
    });

    it("finds a climb or a secret room that breaks its own rules", () => {
        const empty = { ...layout, pieces: [] };
        const problems = (piece: hs.Piece) => hs.layoutProblems({ ...empty, pieces: [piece] });
        const secret = features.find((piece) => piece.kind === "secret")!;
        expect(problems({ ...secret, at: 2 })).toContain("secret 0 has no door");
        expect(
            problems({ kind: "rafter", x: 5, z: 6, level: 1, w: 7, d: 1, h: 5, side: "west" })
        ).toContain("rafter 0 is not against a wall");
        expect(
            problems({ kind: "steps", x: 1, z: 6, level: 1, w: 5, d: 3, h: 4, side: "west" })
        ).toContain("steps 0 is the wrong size");
        expect(
            problems({ kind: "perch", x: 6, z: 6, level: 2, w: 3, d: 2, h: 4, side: "west" })
        ).toContain("piece 0 floats");
        const loft = layout.lofts[0]!;
        expect(
            problems({
                kind: "perch",
                x: loft.x1,
                z: loft.z1,
                level: 1,
                w: 3,
                d: 2,
                h: 4,
                side: "west"
            })
        ).toContain("perch 0 is in a loft's way");
        expect(problems({ ...secret, x: 18, z: 14, side: "north", w: 5, d: 4 }).join(" ")).toMatch(
            /secret 0 is in the cage's room/
        );
    });

    it("keeps a house built by design 2 exactly as that design drew it", () => {
        // Fingerprints of `layoutFor(seed)` and its fills under design 2, taken
        // before design 3 existed: an update must not move a hall's pieces,
        // its mirror or its doors under a run that is still playing in it.
        const hash = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
        const before: Record<string, [string, string]> = {
            "run-0": ["170dc90d6c9c03b3", "d50fb43c7f5a12a8"],
            "run-1": ["7d215dbe9ba843c3", "2ad02c4b3f135858"],
            "run-7": ["368727a31eaf2204", "8f915a0354b993b5"],
            abc: ["2366a8575ae6f988", "7ee4fba867dcccd1"],
            cm123xyz: ["60f11e913b7d9633", "f5a5df9e7175cd43"]
        };
        for (const [seed, [drawn, built]] of Object.entries(before)) {
            const old = hs.layoutFor(seed, 2);
            expect(hash(old)).toBe(drawn);
            expect(hash(hs.hallFills(box, old))).toBe(built);
            expect(old.pieces.some((piece) => FEATURES.includes(piece.kind))).toBe(false);
            expect(hs.doorLines(box, old)).toEqual([]);
            expect(hs.layoutFor(seed)).not.toEqual(old);
        }
    });

    it("puts each door's marker where the pack's offsets find its pistons, doorway, power and buttons", () => {
        const R = doors.RISE;
        for (let seed = 0; seed < 20; seed += 1) {
            const one = hs.layoutFor(`doors-${seed}`);
            const world = new Map<string, string>();
            for (const fill of hs.hallFills(box, one))
                for (let x = fill.box.x1; x <= fill.box.x2; x += 1)
                    for (let y = fill.box.y1; y <= fill.box.y2; y += 1)
                        for (let z = fill.box.z1; z <= fill.box.z2; z += 1)
                            if (!world.has(`${x},${y},${z}`))
                                world.set(`${x},${y},${z}`, fill.block);
            const marks = hs.doorMarks(box, one);
            expect(marks).toHaveLength(hs.hidingPlaces(one).secret);
            for (const mark of marks) {
                const at = (dx: number, rise: number, dz: number) =>
                    world.get(`${mark.x + dx},${mark.y + rise - R.mark},${mark.z + dz}`);
                expect(at(0, R.mark, 0)).toBe("minecraft:spruce_planks");
                expect(at(0, R.topPower, 0)).toBeUndefined();
                expect(at(0, R.topPiston, 0)).toBe(
                    "minecraft:sticky_piston[facing=down,extended=false]"
                );
                expect(at(0, R.upperShelf, 0)).toBe("minecraft:bookshelf");
                expect(at(0, 1, 0)).toBeUndefined();
                expect(at(0, 0, 0)).toBeUndefined();
                expect(at(0, R.lowShelf, 0)).toBe("minecraft:bookshelf");
                expect(at(0, R.lowPiston, 0)).toBe(
                    "minecraft:sticky_piston[facing=up,extended=false]"
                );
                expect(at(0, R.lowPower, 0)).toBeUndefined();
                // Barrier under the power, nothing else that conducts beside it.
                expect(at(0, R.lowPower - 1, 0)).toBe("minecraft:barrier");
                const corners = [
                    [1, 1],
                    [1, -1],
                    [-1, 1],
                    [-1, -1]
                ].map(([dx, dz]) => at(dx!, R.button, dz!) ?? "");
                expect(corners.filter((block) => block.startsWith(doors.BUTTON))).toHaveLength(2);
                // Nothing beside the pistons a button could power: only the
                // bookcase's own blocks and the floor.
                for (const [dx, dz] of [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ] as const) {
                    for (const rise of [R.lowPiston, R.topPiston, R.topPower, R.lowPower])
                        expect(at(dx, rise, dz) ?? "").not.toMatch(/button|redstone|piston/);
                    expect(at(dx, R.button, dz) ?? "").not.toMatch(/button/);
                }
            }
        }
    });

    it("works each door from the events data pack, in commands every release from 1.13 reads", () => {
        const files = pack.packFiles();
        for (const folder of ["functions", "function"]) {
            expect(files.get(`data/minecraft/tags/${folder}/tick.json`)).toContain(
                "polaris:door/tick"
            );
            for (const name of ["tick", "each", "work", "open", "shut"])
                expect(files.get(`data/polaris/${folder}/door/${name}.mcfunction`)).toBe(
                    `${doors.FUNCTIONS[name]!.join("\n")}\n`
                );
        }
        expect(doors.FUNCTIONS.tick).toEqual([
            "execute if entity @a[tag=pe_arena] store result score #now polaris_dlast run time query gametime",
            "execute as @a[tag=pe_arena] at @s as @e[type=minecraft:armor_stand,tag=pe_door,distance=..12] at @s run function polaris:door/each"
        ]);
        expect(doors.FUNCTIONS.each).toEqual([
            "execute unless score @s polaris_dlast = #now polaris_dlast run function polaris:door/work"
        ]);
        expect(doors.FUNCTIONS.work).toEqual([
            "scoreboard players operation @s polaris_dlast = #now polaris_dlast",
            "scoreboard players add @s polaris_door 0",
            "scoreboard players add @s polaris_dwait 0",
            "execute if block ~1 ~-4 ~1 minecraft:oak_button[powered=true] run scoreboard players set @s polaris_door 70",
            "execute if block ~1 ~-4 ~-1 minecraft:oak_button[powered=true] run scoreboard players set @s polaris_door 70",
            "execute if block ~-1 ~-4 ~1 minecraft:oak_button[powered=true] run scoreboard players set @s polaris_door 70",
            "execute if block ~-1 ~-4 ~-1 minecraft:oak_button[powered=true] run scoreboard players set @s polaris_door 70",
            "execute if score @s polaris_dwait matches 1.. run scoreboard players remove @s polaris_dwait 1",
            "execute if score @s polaris_door matches 1.. if score @s polaris_dwait matches ..0 if entity @s[tag=pe_door_shut] run function polaris:door/open",
            "execute if entity @s[tag=pe_door_shut] if score @s polaris_dwait matches ..0 positioned ~ ~-5 ~ align xyz if entity @e[type=!minecraft:item,dx=0,dy=1,dz=0] at @s run function polaris:door/open",
            "execute if score @s polaris_door matches 1.. run scoreboard players remove @s polaris_door 1",
            "execute if score @s polaris_door matches ..0 if score @s polaris_dwait matches ..0 if entity @s[tag=!pe_door_shut] positioned ~-1 ~-5 ~-1 align xyz unless entity @e[type=!minecraft:item,dx=2,dy=1,dz=2] at @s run function polaris:door/shut"
        ]);
        expect(doors.FUNCTIONS.open).toEqual([
            "execute if block ~ ~-8 ~ minecraft:redstone_block run setblock ~ ~-8 ~ minecraft:air",
            "execute if block ~ ~-1 ~ minecraft:redstone_block run setblock ~ ~-1 ~ minecraft:air",
            "tag @s remove pe_door_shut",
            "scoreboard players set @s polaris_dwait 4"
        ]);
        expect(doors.FUNCTIONS.shut).toEqual([
            "execute if block ~ ~-7 ~ minecraft:sticky_piston if block ~ ~-8 ~ minecraft:air run setblock ~ ~-8 ~ minecraft:redstone_block",
            "execute if block ~ ~-2 ~ minecraft:sticky_piston if block ~ ~-1 ~ minecraft:air run setblock ~ ~-1 ~ minecraft:redstone_block",
            "tag @s add pe_door_shut",
            "scoreboard players set @s polaris_dwait 4"
        ]);
        // Five seconds from a wooden button's press (its pulse is 30 ticks),
        // and no piston touched again before it has finished moving (2 ticks).
        expect((doors.OPEN_TICKS + 30) / 20).toBe(5);
        expect(doors.SETTLE_TICKS).toBeGreaterThan(2);
        // Every scoreboard name fits the oldest releases.
        for (const objective of doors.OBJECTIVES) expect(objective.length).toBeLessThanOrEqual(16);
    });

    it("puts the doors to work at Go and stops them at the end, inside the house alone", () => {
        const marks = hs.doorMarks(box, layout);
        expect(marks).toHaveLength(2);
        const inBox = `x=${box.x1},y=${box.y1},z=${box.z1},dx=${box.x2 - box.x1},dy=${box.y2 - box.y1},dz=${box.z2 - box.z1}`;
        expect(hs.doorLines(box, layout)).toEqual([
            `execute in minecraft:overworld run kill @e[type=minecraft:armor_stand,tag=pe_door,${inBox}]`,
            "scoreboard objectives add polaris_door dummy",
            "scoreboard objectives add polaris_dwait dummy",
            "scoreboard objectives add polaris_dlast dummy",
            "execute store result score #now polaris_dlast run time query gametime",
            ...marks.map(
                (mark) =>
                    `execute in minecraft:overworld run summon minecraft:armor_stand ${mark.x + 0.5} ${mark.y} ${mark.z + 0.5} {Tags:["pe_door"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`
            ),
            `execute in minecraft:overworld as @e[type=minecraft:armor_stand,tag=pe_door,${inBox}] at @s run function polaris:door/each`
        ]);
        for (const mark of marks) {
            expect(arena.contains(box, mark)).toBe(true);
            expect(mark.y).toBe(box.y1 + 3 + 1 + doors.RISE.mark);
        }
        // At the end: nothing works them any more, and every one is open.
        expect(hs.doorsOff(box)).toEqual([
            `execute in minecraft:overworld run kill @e[type=minecraft:armor_stand,tag=pe_door,${inBox}]`,
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace minecraft:redstone_block`
        ]);
        expect(
            (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1)
        ).toBeLessThanOrEqual(32_768);
        // Before the house comes down: only the markers, so nothing moves.
        expect(hs.doorsStill(box)).toEqual([
            `execute in minecraft:overworld run kill @e[type=minecraft:armor_stand,tag=pe_door,${inBox}]`
        ]);
        for (const objective of doors.OBJECTIVES)
            expect(hs.TEARDOWN).toContain(`scoreboard objectives remove ${objective}`);
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
                said.secretTip(language),
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
