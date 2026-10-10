/**
 * Every block an event puts in the world comes down with it. A teardown takes
 * only the block kinds the event lists - an arena's `arena.withDecayed(list)`,
 * a stage's own boxes - so a block it placed but did not list, or one a listed
 * block turned into while it stood (grass under a trunk gone to dirt, dirt
 * grown over, water frozen, ice melted, lava met by water), is left floating
 * in the sky once the rest is gone.
 *
 * For every kind: what its fills, decorations and kit place, and what each of
 * those can become in the world, must all be in what its teardown takes.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as hill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as sw from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars";
import * as spleef from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";
import * as tntRun from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tnt-run";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as parkour from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour";
import * as dropper from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/dropper";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as potato from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hot-potato";
import * as build from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/build-battle";
import * as boatRace from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boat-race";
import * as acidRain from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/acid-rain";
import * as netherMaze from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/nether-maze";
import * as elytraRace from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/elytra-race";
import * as ctf from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/capture-the-flag";
import * as downhill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/downhill-race";

const SITE = { x: 300, z: -120 };
const Y = 100;
const SEEDS = 12;

const bare = (id: string) => id.replace(/\[.*$/, "").replace(/\{.*$/, "");

/** The block ids lines of commands put down with `setblock` or `fill` - not
 *  the blocks a handed-out item can be placed on, which it does not place. */
function placedBy(lines: readonly string[]): string[] {
    const ids: string[] = [];
    for (const line of lines) {
        const set =
            /\b(?:setblock -?\d+ -?\d+ -?\d+|fill(?: -?\d+){6}) (minecraft:[a-z0-9_]+)/.exec(line);
        if (set && set[1] !== "minecraft:air") ids.push(set[1]!);
    }
    return ids;
}

/** Item ids handed out by `give` and `item replace` lines. */
function handedOut(lines: readonly string[]): string[] {
    const ids: string[] = [];
    for (const line of lines) {
        const given = /^(?:execute .* run )?give \S+ (minecraft:[a-z0-9_]+)/.exec(line);
        const put = / with (minecraft:[a-z0-9_]+)/.exec(line);
        const old = / replaceitem \S+ .* (minecraft:[a-z0-9_]+)/.exec(line);
        for (const match of [given, put, old]) if (match) ids.push(match[1]!);
    }
    return ids;
}

/**
 * What a kit can do to the world it is used in: the items it carries, and the
 * blocks a player can put down from it - in adventure mode, only what carries
 * `can_place_on`; in survival (SkyWars after "Go!"), any block in hand.
 */
interface Kit {
    readonly items: readonly string[];
    readonly places?: readonly string[];
}

/**
 * What the blocks an event placed can become while it stands, with what its
 * kit can do to them: the in-world changes a teardown has to expect.
 */
function becomes(placed: ReadonlySet<string>, kit: Kit): Set<string> {
    const out = new Set(placed);
    const has = (id: string) => placed.has(id);
    const carries = (pattern: RegExp) => kit.items.some((id) => pattern.test(id));
    for (const id of placed) {
        // Grass, mycelium and podzol under something solid go to dirt; dirt
        // next to grass grows over, or to mycelium where it is about.
        if (/^minecraft:(grass_block|mycelium|podzol)$/.test(id)) out.add("minecraft:dirt");
        if (id === "minecraft:dirt") {
            out.add("minecraft:grass_block");
            if (has("minecraft:mycelium")) out.add("minecraft:mycelium");
        }
        // Water open to a cold sky freezes; ice by a light melts.
        if (id === "minecraft:water") out.add("minecraft:ice");
        if (id === "minecraft:ice") out.add("minecraft:water");
        // Powder by water sets.
        const powder = /^minecraft:(\w+)_concrete_powder$/.exec(id);
        if (powder && (has("minecraft:water") || carries(/water_bucket$/)))
            out.add(`minecraft:${powder[1]}_concrete`);
    }
    // Water meeting lava.
    const water = has("minecraft:water") || carries(/water_bucket$/);
    const lava = has("minecraft:lava") || carries(/lava_bucket$/);
    if (water && lava)
        for (const id of ["minecraft:cobblestone", "minecraft:stone", "minecraft:obsidian"])
            out.add(id);
    if (carries(/water_bucket$/)) out.add("minecraft:water");
    if (carries(/lava_bucket$/)) out.add("minecraft:lava");
    // Fire, from a striker or a bucket of lava.
    if (carries(/(flint_and_steel|lava_bucket|fire_charge)$/)) out.add("minecraft:fire");
    // A hoe tills, a shovel cuts a path, in what they can work.
    const soil = ["minecraft:dirt", "minecraft:grass_block", "minecraft:coarse_dirt"].some((one) =>
        out.has(one)
    );
    if (soil && carries(/_hoe$/)) out.add("minecraft:farmland");
    if (soil && carries(/_shovel$/)) out.add("minecraft:dirt_path");
    return out;
}

/** What of `placed`, and of what it becomes, a teardown of `taken` leaves. */
function leftBehind(placed: Iterable<string>, kit: Kit, taken: Iterable<string>): string[] {
    const placedSet = new Set([...placed].map(bare));
    // A block put down from the kit is placed too.
    for (const id of kit.places ?? []) placedSet.add(bare(id));
    const gone = new Set(taken);
    return [...becomes(placedSet, kit)].filter((id) => !gone.has(id)).sort();
}

/** An arena kind: what it builds and hands out against `withDecayed(listed)`. */
function arenaLeaves(placed: Iterable<string>, kit: Kit, listed: readonly string[]): string[] {
    return leftBehind(placed, kit, arena.withDecayed(listed.map(bare)));
}

const options = <K extends catalog.EventKind>(kind: K) =>
    catalog.newPreset(kind, "test").options as catalog.EventOptions<K>;

describe("what an arena's teardown takes", () => {
    it("takes dirt's grass and ice's water with them, and nothing for an empty list", () => {
        expect(arena.withDecayed(["minecraft:dirt"])).toContain("minecraft:grass_block");
        expect(arena.withDecayed(["minecraft:ice"])).toContain("minecraft:water");
        expect(arena.withDecayed(["minecraft:grass_block"])).toContain("minecraft:dirt");
        expect(arena.withDecayed([])).toEqual([]);
    });
});

describe("every arena takes down everything it placed", () => {
    it("the team duel", () => {
        const box = duel.duelBox(SITE, Y);
        const fills = duel.duelFills(box).map((one) => one.block);
        const kit = { items: duel.duelKit("iron") };
        expect(arenaLeaves(fills, kit, duel.DUEL_BLOCKS)).toEqual([]);
        expect(arenaLeaves(duel.FLOOR_BLOCKS, kit, duel.DUEL_BLOCKS)).toEqual([]);
    });

    it("the build battle, in every material", () => {
        for (const players of [2, 5, 12]) {
            const size = options("build-battle").plotSize;
            const box = build.platformBox(SITE, Y, players, size);
            const fills = build.platformFills(box, players, size).map((one) => one.block);
            for (const palette of Object.values(build.PALETTES)) {
                const kit = { items: [...palette.blocks, build.TOOL], places: palette.blocks };
                expect(arenaLeaves(fills, kit, build.PLATFORM_BLOCKS)).toEqual([]);
            }
        }
    });

    it("capture the flag", () => {
        const box = ctf.arenaBox(SITE, Y);
        const kit = { items: [...duel.duelKit("iron"), ...ctf.BANNERS] };
        for (let seed = 0; seed < SEEDS * 10; seed += 1) {
            const fills = ctf.arenaFills(box, ctf.coverFor(`run-${seed}`)).map((one) => one.block);
            expect(arenaLeaves(fills, kit, ctf.ARENA_BLOCKS)).toEqual([]);
        }
    });

    it("SkyWars, its islands, chests and loot", () => {
        for (const players of [2, 6, 12])
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const id = `run-${seed}`;
                const layout = sw.layoutFor(id, players);
                const at = { x: SITE.x, y: Y, z: SITE.z };
                const fills = sw.arenaFills(layout, at).map((one) => one.block);
                const chests = sw.chestLines(id, layout, at, "rich", "components", true);
                const loot = [...handedOut(chests), ...sw.LOOT_IDS, ...sw.BRIDGES];
                // Survival from "Go!": any block in hand goes down - the
                // chests' and whatever an island drops when broken.
                const blocks = [...sw.BRIDGES, "minecraft:cobblestone", "minecraft:dirt"];
                expect(
                    arenaLeaves(
                        [...fills, ...placedBy(chests)],
                        { items: loot, places: blocks },
                        sw.ARENA_BLOCKS
                    )
                ).toEqual([]);
            }
    });

    it("the king of the hill", () => {
        for (const radius of [4, 8, 12]) {
            const place = { x: SITE.x, y: Y, z: SITE.z };
            const placed = [
                ...hill.platformDecor(place, radius).map((one) => one.block),
                hill.PLATFORM_BLOCK,
                ...placedBy(hill.redrawLines(place, radius, place, Math.max(1, radius - 2)))
            ];
            expect(arenaLeaves(placed, { items: [hill.CROWN] }, hill.PLATFORM_BLOCKS)).toEqual([]);
        }
    });

    it("hot potato", () => {
        for (const players of [2, 6, 12]) {
            const box = potato.platformBox(SITE, Y, players);
            const fills = potato.platformFills(box).map((one) => one.block);
            // The TNT is worn, in adventure mode: it cannot be put down.
            expect(arenaLeaves(fills, { items: [potato.POTATO] }, potato.PLATFORM_BLOCKS)).toEqual(
                []
            );
        }
    });

    it("the hide and seek halls older runs still rebuild", () => {
        const box = { x1: 0, y1: 0, z1: 0, x2: 40, y2: 20, z2: 40 };
        for (const design of [2, 3])
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const layout = hs.layoutFor(`hall-${seed}`, design);
                const placed = [
                    ...hs.hallFills(box, layout).map((one) => one.block),
                    ...placedBy(hs.doorLines(box, layout))
                ];
                expect(arenaLeaves(placed, { items: [] }, hs.HALL_BLOCKS)).toEqual([]);
            }
    });

    it("the hide and seek manor, in every era", () => {
        const eras: readonly model.Era[] = [
            model.OLDEST,
            { scaffold: true, snow: false, display: false },
            { scaffold: true, snow: true, display: false },
            model.NEWEST
        ];
        const problems = new Set<string>();
        for (const count of [3, 4, 5])
            for (const era of eras)
                for (let seed = 0; seed < SEEDS; seed += 1)
                    for (let draw = 0; draw < 3; draw += 1) {
                        const house = manor.drawManor(`blocks-${seed}`, count, era, draw);
                        const box = manor.hallBox({ x: SITE.x, y: Y, z: SITE.z }, Y, count);
                        const placed = [
                            ...manor.manorFills(box, house).map((one) => one.block),
                            ...placedBy(manor.decorLines(box, house))
                        ];
                        for (const id of arenaLeaves(
                            placed,
                            { items: [] },
                            manor.manorBlocks(house)
                        ))
                            problems.add(id);
                    }
        expect([...problems].sort()).toEqual([]);
    }, 120_000);
});

/** A stage kind: each box comes out by its own block (`stage.removeLine`). */
function stageLeaves(
    boxes: readonly { block: string }[],
    kit: Kit,
    extra: readonly { block: string }[] = []
): string[] {
    const blocks = boxes.map((one) => one.block);
    return leftBehind(blocks, kit, [...blocks, ...extra.map((one) => one.block)].map(bare));
}

describe("every stage takes down everything it placed", () => {
    it("spleef", () => {
        for (const size of [8, 14, 20]) {
            const built = spleef.arena({ ...options("spleef"), size }, SITE, Y);
            const kit = { items: ["minecraft:iron_shovel", "minecraft:snowball"] };
            expect(stageLeaves(built.boxes, kit)).toEqual([]);
        }
    });

    it("TNT run", () => {
        for (const layers of [1, 2, 3]) {
            const built = tntRun.arena({ ...options("tnt-run"), layers }, SITE, Y);
            expect(stageLeaves(built.boxes, { items: [] })).toEqual([]);
        }
    });

    it("parkour, every difficulty and shape", () => {
        const base = options("parkour");
        for (const difficulty of ["easy", "medium", "hard"] as const)
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const built = parkour.course({ ...base, difficulty }, `run-${seed}`, SITE, Y);
                expect(stageLeaves(built.boxes, { items: [] })).toEqual([]);
            }
    });

    it("the downhill race", () => {
        for (const steepness of ["gentle", "steep"] as const)
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const built = downhill.course({ steepness }, `run-${seed}`, SITE, Y);
                expect(stageLeaves(built.boxes, { items: [] })).toEqual([]);
            }
    });

    it("the boat race", () => {
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const built = boatRace.track(options("boat-race"), `run-${seed}`, SITE, Y);
            expect(stageLeaves(built.boxes, { items: [] })).toEqual([]);
        }
    });

    it("the dropper", () => {
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const built = dropper.shaft(options("dropper"), `run-${seed}`, SITE, Y);
            // Its water lies under a lid of glass and a ring of light: it never
            // sees the sky to freeze under.
            const lid = built.boxes.filter((one) => one.block === "minecraft:glass");
            expect(lid.length).toBeGreaterThan(0);
            const left = stageLeaves(built.boxes, { items: [] }).filter(
                (id) => id !== "minecraft:ice"
            );
            expect(left).toEqual([]);
        }
    });

    it("the nether maze, every size and hazard", () => {
        for (const size of ["small", "medium", "large"] as const)
            for (const hazards of ["few", "some", "many"] as const)
                for (let seed = 0; seed < 4; seed += 1) {
                    const built = netherMaze.maze({ size, hazards }, `run-${seed}`, SITE, Y);
                    expect(stageLeaves(built.boxes, { items: [] })).toEqual([]);
                }
    });

    it("the elytra race", () => {
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const built = elytraRace.course(options("elytra-race"), `run-${seed}`, SITE, Y);
            expect(stageLeaves(built.boxes, { items: [] })).toEqual([]);
        }
    });

    it("acid rain, the cobblestone it hands out included", () => {
        for (const size of ["small", "medium", "large"] as const) {
            const built = acidRain.arena({ ...options("acid-rain"), size }, "run-1", SITE, Y);
            const given = handedOut([acidRain.cobblestoneLine("Ana", "components", 16)]);
            const kit = { items: given, places: given };
            expect(stageLeaves(built.boxes, kit, acidRain.sweepBoxes(built))).toEqual([]);
        }
    });
});
