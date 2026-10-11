/**
 * Blocks that fall - an anvil, a stalactite, scaffolding, sand, gravel,
 * concrete powder - must never be let loose by an event. One with nothing
 * under it turns into a falling block and lands as a real block wherever it
 * comes down, outside the event's box, where no teardown looks for it: a
 * hide and seek house once left its anvils and stalactites on the ground
 * under the sky it had stood in.
 *
 * Two rules, for every kind that builds:
 * - built: every block that falls has something holding it the moment it is
 *   placed (`stage.falls`);
 * - taken down: those kinds go before any other block, highest slice first,
 *   and the falling blocks under the box are removed after (`arena.teardown`).
 */

import { describe, expect, it } from "vitest";
import * as state from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as hill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as sw from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";
import * as tug from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tug-of-war";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as potato from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hot-potato";
import * as impostor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/impostor";
import * as glass from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/glass-bridge";
import * as build from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/build-battle";
import * as ctf from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/capture-the-flag";

type Box = state.Box;

const SITE = { x: 300, z: -120 };
const Y = 100;
const SEEDS = 6;

/** One thing the build does, in the order it does it. `keep` only fills air. */
interface Step {
    readonly box: Box;
    readonly block: string;
    readonly keep: boolean;
}

/** An arena's fills as the build sends them: each a slice at a time, bottom up. */
function fillSteps(fills: readonly { box: Box; block: string }[]): Step[] {
    return fills.flatMap((one) =>
        arena.slices(one.box).map((box) => ({ box, block: one.block, keep: true }))
    );
}

/** The `setblock` and `fill` lines a kind sends after its fills. */
function lineSteps(lines: readonly string[]): Step[] {
    const steps: Step[] = [];
    for (const line of lines) {
        const set =
            /\bsetblock (-?\d+) (-?\d+) (-?\d+) (minecraft:[a-z0-9_]+(?:\[[^\]]*\])?)(.*)$/.exec(
                line
            );
        const fill =
            /\bfill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (minecraft:[a-z0-9_]+(?:\[[^\]]*\])?)(.*)$/.exec(
                line
            );
        if (set) {
            const [x, y, z] = [set[1], set[2], set[3]].map(Number) as [number, number, number];
            const box = { x1: x, y1: y, z1: z, x2: x, y2: y, z2: z };
            steps.push({ box, block: set[4]!, keep: /\bkeep\b/.test(set[5]!) });
        } else if (fill) {
            const n = fill.slice(1, 7).map(Number) as number[];
            const box = {
                x1: Math.min(n[0]!, n[3]!),
                y1: Math.min(n[1]!, n[4]!),
                z1: Math.min(n[2]!, n[5]!),
                x2: Math.max(n[0]!, n[3]!),
                y2: Math.max(n[1]!, n[4]!),
                z2: Math.max(n[2]!, n[5]!)
            };
            steps.push({ box, block: fill[7]!, keep: /\bkeep\b/.test(fill[8]!) });
        }
    }
    return steps;
}

const bare = (block: string) => block.replace(/[[{].*$/, "");

/** What a falling block passes through, as the game has it: air, fire,
 *  liquids and what a block placed there would replace. */
const FREE =
    /^minecraft:(air|cave_air|void_air|fire|soul_fire|water|lava|bubble_column|structure_void|light|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|tall_seagrass)$/;

/** The block at a point once `upTo` steps (inclusive) are done, or null for air. */
function blockAt(steps: readonly Step[], upTo: number, x: number, y: number, z: number) {
    let at: string | null = null;
    for (let i = 0; i <= upTo; i += 1) {
        const { box, block, keep } = steps[i]!;
        if (x < box.x1 || x > box.x2 || y < box.y1 || y > box.y2 || z < box.z1 || z > box.z2)
            continue;
        if (keep && at !== null) continue;
        at = bare(block) === "minecraft:air" ? null : block;
    }
    return at;
}

/** Each block that falls with nothing holding it when it is placed, as `id@x,y,z`. */
function unsupported(steps: readonly Step[]): string[] {
    const loose: string[] = [];
    steps.forEach((step, index) => {
        if (!stage.falls(step.block)) return;
        // A stalactite hangs from what is over it; everything else stands.
        const hangs =
            /pointed_dripstone/.test(step.block) && /vertical_direction=down/.test(step.block);
        const { box } = step;
        for (let x = box.x1; x <= box.x2; x += 1)
            for (let y = box.y1; y <= box.y2; y += 1)
                for (let z = box.z1; z <= box.z2; z += 1) {
                    // Not placed at all: `keep` and something already there.
                    if (blockAt(steps, index, x, y, z) !== step.block) continue;
                    const holder = blockAt(steps, index, x, hangs ? y + 1 : y - 1, z);
                    if (holder === null || FREE.test(bare(holder)))
                        loose.push(`${bare(step.block)}@${x},${y},${z}`);
                }
    });
    return loose;
}

/**
 * Whether a teardown takes every block that falls before any block that does
 * not: no line for one between the first and the last line for the rest. A
 * second pass after the rest - for what fell anyway - is allowed.
 */
function fallersFirst(lines: readonly string[]): boolean {
    const replaced = lines
        .map((line) => / replace (minecraft:[a-z0-9_]+)$/.exec(line)?.[1] ?? null)
        .filter((id): id is string => id !== null);
    const firstSteady = replaced.findIndex((id) => !stage.falls(id));
    if (firstSteady === -1) return true;
    const lastSteady = replaced.findLastIndex((id) => !stage.falls(id));
    return !replaced.slice(firstSteady, lastSteady).some((id) => stage.falls(id));
}

const options = <K extends catalog.EventKind>(kind: K) =>
    catalog.newPreset(kind, "test").options as catalog.EventOptions<K>;

/** Every arena kind's builds over many seeds and sizes, with the blocks its teardown lists. */
function* arenaBuilds(): Generator<{ name: string; steps: Step[]; blocks: string[]; box: Box }> {
    const duelBox = duel.duelBox(SITE, Y);
    yield {
        name: "team duel",
        steps: fillSteps(duel.duelFills(duelBox)),
        blocks: [...duel.DUEL_BLOCKS],
        box: duelBox
    };
    for (const players of [2, 5, 12]) {
        const size = options("build-battle").plotSize;
        const box = build.platformBox(SITE, Y, players, size);
        const fills = build.platformFills(box, players, size);
        yield {
            name: `build battle ${players}`,
            steps: fillSteps(fills),
            blocks: [...new Set([...fills.map((one) => one.block), ...build.PLATFORM_BLOCKS])],
            box
        };
    }
    const ctfBox = ctf.arenaBox(SITE, Y);
    for (let seed = 0; seed < SEEDS * 4; seed += 1)
        yield {
            name: `capture the flag ${seed}`,
            steps: fillSteps(ctf.arenaFills(ctfBox, ctf.coverFor(`run-${seed}`))),
            blocks: [...ctf.ARENA_BLOCKS],
            box: ctfBox
        };
    for (const players of [2, 6, 12])
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const id = `run-${seed}`;
            const layout = sw.layoutFor(id, players);
            const at = { x: SITE.x, y: Y, z: SITE.z };
            yield {
                name: `sky wars ${players}/${seed}`,
                steps: [
                    ...fillSteps(sw.arenaFills(layout, at)),
                    ...lineSteps(sw.chestLines(id, layout, at, "rich", "components", true))
                ],
                blocks: [...sw.ARENA_BLOCKS],
                box: sw.arenaBox(layout, at)
            };
        }
    for (const radius of [4, 8, 12]) {
        const place = { x: SITE.x, y: Y, z: SITE.z };
        yield {
            name: `king of the hill ${radius}`,
            steps: [
                ...fillSteps(hill.platformDecor(place, radius)),
                ...lineSteps(hill.redrawLines(place, radius, place, Math.max(1, radius - 2)))
            ],
            blocks: [...hill.PLATFORM_BLOCKS],
            box: hill.bounds(place, radius)
        };
    }
    for (const players of [2, 6, 12]) {
        const box = potato.platformBox(SITE, Y, players);
        yield {
            name: `hot potato ${players}`,
            steps: fillSteps(potato.platformFills(box, `run-${players}`)),
            blocks: [...potato.PLATFORM_BLOCKS],
            box
        };
    }
    for (const players of [4, 9, 15])
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const box = impostor.stationBox(SITE, Y, players);
            yield {
                name: `impostor ${players}/${seed}`,
                steps: fillSteps(impostor.stationFills(impostor.layoutFor(`run-${seed}`, box))),
                blocks: impostor.stationBlocks(),
                box
            };
        }
    for (const steps of [5, options("glass-bridge").steps, 20]) {
        const box = glass.bridgeBox(SITE, Y, steps);
        yield {
            name: `glass bridge ${steps}`,
            steps: fillSteps(glass.bridgeFills(box, steps)),
            blocks: [...glass.BRIDGE_BLOCKS],
            box
        };
    }
    for (const length of [tug.DEFAULT_LENGTH, tug.DEFAULT_LENGTH * 2]) {
        const box = tug.arenaBox(SITE, Y, length);
        yield {
            name: `tug of war ${length}`,
            steps: fillSteps(tug.arenaFills(box, length)),
            blocks: [...tug.ARENA_BLOCKS],
            box
        };
    }
    const hall = { x1: 0, y1: 0, z1: 0, x2: 40, y2: 20, z2: 40 };
    for (const design of [2, 3])
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const layout = hs.layoutFor(`hall-${seed}`, design);
            yield {
                name: `hide and seek hall ${design}/${seed}`,
                steps: [
                    ...fillSteps(hs.hallFills(hall, layout)),
                    ...lineSteps(hs.doorLines(hall, layout))
                ],
                blocks: [...hs.HALL_BLOCKS],
                box: hall
            };
        }
    const eras: readonly model.Era[] = [
        model.OLDEST,
        { scaffold: true, snow: false, display: false },
        { scaffold: true, snow: true, display: false },
        model.NEWEST
    ];
    for (const count of [3, 4, 5])
        for (const era of eras)
            for (let seed = 0; seed < SEEDS; seed += 1) {
                const house = manor.drawManor(`gravity-${seed}`, count, era, seed % 3);
                const box = manor.hallBox({ x: SITE.x, y: Y, z: SITE.z }, Y, count);
                yield {
                    name: `hide and seek manor ${count}/${seed}`,
                    steps: [
                        ...fillSteps(manor.manorFills(box, house)),
                        ...lineSteps(manor.decorLines(box, house))
                    ],
                    blocks: manor.manorBlocks(house),
                    box
                };
            }
}

describe("blocks that fall", () => {
    it("knows every anvil, powder, sand and gravel, with or without a state", () => {
        for (const id of [
            "minecraft:anvil[facing=east]",
            "minecraft:damaged_anvil",
            "minecraft:chipped_anvil",
            "minecraft:gravel",
            "minecraft:suspicious_sand",
            "minecraft:lime_concrete_powder",
            "minecraft:pointed_dripstone[vertical_direction=down,thickness=tip]",
            "minecraft:scaffolding[distance=0,bottom=false]",
            "minecraft:dragon_egg"
        ])
            expect(stage.falls(id)).toBe(true);
        for (const id of ["minecraft:sandstone", "minecraft:lime_concrete", "minecraft:soul_sand"])
            expect(stage.falls(id)).toBe(false);
    });

    it("no stage block can fall: a stage takes its boxes out latest first", () => {
        expect(stage.ARENA_BLOCKS.filter((id) => stage.falls(id))).toEqual([]);
    });
});

describe("the support check itself", () => {
    const at = (y: number) => ({ x1: 0, y1: y, z1: 0, x2: 2, y2: y, z2: 0 });

    it("finds an anvil over air, and one put down before its floor", () => {
        expect(unsupported([{ box: at(5), block: "minecraft:anvil", keep: true }])).toHaveLength(3);
        expect(
            unsupported([
                { box: at(5), block: "minecraft:anvil", keep: true },
                { box: at(4), block: "minecraft:stone", keep: true }
            ])
        ).toHaveLength(3);
    });

    it("passes an anvil on its floor and a stalactite under its ceiling", () => {
        expect(
            unsupported([
                { box: at(4), block: "minecraft:stone", keep: true },
                { box: at(5), block: "minecraft:anvil", keep: true },
                { box: at(7), block: "minecraft:stone", keep: true },
                {
                    box: at(6),
                    block: "minecraft:pointed_dripstone[vertical_direction=down]",
                    keep: true
                }
            ])
        ).toEqual([]);
    });
});

describe("an arena's teardown and blocks that fall", () => {
    const box = { x1: 0, y1: 100, z1: 0, x2: 99, y2: 139, z2: 99 };
    const built = {
        box,
        blocks: ["minecraft:oak_planks", "minecraft:anvil", "minecraft:pointed_dripstone"]
    };

    it("takes them before anything else, the highest slice first", () => {
        const lines = arena.teardown(built);
        expect(fallersFirst(lines)).toBe(true);
        const anvils = lines.filter((line) => line.endsWith("replace minecraft:anvil"));
        const floors = anvils.map((line) => Number(/fill -?\d+ (-?\d+)/.exec(line)![1]));
        expect(floors.length).toBeGreaterThan(1);
        // Taken top down, then once more after the rest for what fell anyway.
        const firstPass = floors.slice(0, arena.slices(box).length);
        expect(firstPass).toEqual([...firstPass].sort((a, b) => b - a));
    });

    it("removes falling blocks in the box and just under it, and nothing past the box", () => {
        const lines = arena.teardown(built);
        const kill = lines.find((line) => line.includes("falling_block"))!;
        expect(kill).toBe(
            `execute in minecraft:overworld run kill @e[type=minecraft:falling_block,x=0,y=${100 - stage.FALL_MARGIN},z=0,dx=99,dy=${39 + stage.FALL_MARGIN},dz=99]`
        );
        for (const line of lines) {
            expect(line).not.toMatch(/\bdestroy\b/);
            const fill = /fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(line);
            if (!fill) continue;
            const [x1, y1, z1, x2, y2, z2] = fill.slice(1).map(Number) as number[];
            expect(x1! >= box.x1 && x2! <= box.x2 && z1! >= box.z1 && z2! <= box.z2).toBe(true);
            expect(y1! >= box.y1 && y2! <= box.y2).toBe(true);
        }
    });

    it("on a proved box, sweeps it whole after, and on an unproved one takes them twice", () => {
        const proved = arena.teardown({ ...built, proved: box });
        expect(proved.filter((line) => line.endsWith("replace minecraft:anvil"))).toHaveLength(
            arena.slices(box).length
        );
        expect(proved.some((line) => line.endsWith(" minecraft:air"))).toBe(true);
        expect(
            arena.teardown(built).filter((line) => line.endsWith("replace minecraft:anvil"))
        ).toHaveLength(arena.slices(box).length * 2);
    });
});

describe("every arena kind and blocks that fall", () => {
    it("never puts one where nothing holds it, and takes them down first", () => {
        const loose = new Set<string>();
        const late = new Set<string>();
        const fallers = new Set<string>();
        for (const one of arenaBuilds()) {
            for (const step of one.steps)
                if (stage.falls(step.block)) fallers.add(bare(step.block));
            for (const spot of unsupported(one.steps)) loose.add(`${one.name}: ${spot}`);
            const listed = one.blocks.map(bare);
            const teardown = arena.teardown({ box: one.box, blocks: listed, proved: one.box });
            if (!fallersFirst(teardown)) late.add(one.name);
            // Every block that falls the build places is a kind its teardown takes.
            for (const step of one.steps)
                if (stage.falls(step.block) && !listed.includes(bare(step.block)))
                    late.add(`${one.name}: ${bare(step.block)} not listed`);
        }
        // The scan is not empty: the manor's anvils, stalactites and scaffolding are in it.
        expect([...fallers].sort()).toEqual(
            expect.arrayContaining(["minecraft:anvil", "minecraft:pointed_dripstone"])
        );
        expect([...loose].slice(0, 20)).toEqual([]);
        expect([...late]).toEqual([]);
    }, 60_000);
});
