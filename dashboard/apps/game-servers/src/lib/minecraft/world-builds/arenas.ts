/**
 * Event arenas from real builds: an alternative layout for an event kind, kept
 * beside the arenas Polaris generates for it (`events/kinds`). A run draws one
 * of them, or the generated arena, from its own seed (`arenaLayoutFor`).
 *
 * A spleef and a TNT run are played on theirs (`floorArena`, read by
 * `stage-service`): the build pasted into air over a glass catch net, inside
 * the volume the probe proved empty, and swept away with it. The king of the
 * hill, team duel and hide-and-seek entries are declared and checked here, but
 * their runner still plays only the generated arena.
 *
 * A build is only an arena when it keeps the event's gameplay contract, so
 * every entry declares it, in cells counted from the build's lowest corner:
 *
 * - spleef and TNT run: the breakable floors, top first, the blocks they are
 *   made of, and where the players start on the top one. A TNT run's build has
 *   nothing that powers redstone, so nothing in it can prime the TNT;
 * - king of the hill: the hill's zone - its top and how far round it counts -
 *   and where the players start, at its foot;
 * - team duel: where each team starts, at opposite ends;
 * - hide and seek: where the seeker starts and where the hiders are let go.
 *
 * `contractProblems` checks each against the blocks themselves: every start
 * stands on solid ground with two cells of air over it, every floor holds the
 * breakable blocks it claims, the hill's zone has ground to stand on. An entry
 * with a problem is left out of `ARENA_BUILDS`, and the tests fail on it.
 *
 * Left out, and why: the parkour build, as nothing here can prove its jumps can
 * be made the way a generated course is proven (`parkour-layout`); the second
 * hide-and-seek map and the Christmas and Halloween scenes too large for a
 * site (more than `ARENA_SIDE_MAX` or `SIDE_MAX` a side).
 */

import { z } from "zod";
import type { Box } from "../events/kinds/stage";
import type { EventKind } from "../events/catalog";
import * as spleef from "../events/kinds/spleef";
import * as tntRun from "../events/kinds/tnt-run";
import { pastePieces, type PastePiece, type Point } from "./plan";
import spleefTower from "./builds/spleef-tower.json";
import tntRunTower from "./builds/tnt-run-tower.json";
import duelMudworks from "./builds/duel-mudworks.json";
import tntRunTemple from "./builds/tnt-run-temple.json";
import { seeded, shuffled } from "../events/trivia-bank";
import hillGlassPeak from "./builds/hill-glass-peak.json";
import seekForestVillage from "./builds/seek-forest-village.json";
import spleefFrozenGarden from "./builds/spleef-frozen-garden.json";
import { AIR, arenaBuildSchema, blockOf, decodeCells, type ArenaBuild } from "./format";

/** The event kinds a build can be the arena of. */
export const ARENA_BUILD_KINDS = [
    "spleef",
    "tnt-run",
    "king-of-the-hill",
    "team-duel",
    "hide-and-seek"
] as const satisfies readonly EventKind[];

export type ArenaBuildKind = (typeof ARENA_BUILD_KINDS)[number];

const cell = z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    z: z.number().int().min(0)
});
const starts = z.array(cell).min(1);
const floor = z.object({
    y: z.number().int().min(0),
    x1: z.number().int().min(0),
    z1: z.number().int().min(0),
    x2: z.number().int().min(0),
    z2: z.number().int().min(0),
    /** How many of the floor's cells are breakable. */
    cells: z.number().int().min(1)
});
const floorGame = {
    breakable: z.array(z.string()).min(1),
    floors: z.array(floor).min(1),
    spawns: starts
};

export const arenaContractSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("spleef"), ...floorGame }),
    z.object({ kind: z.literal("tnt-run"), ...floorGame }),
    z.object({
        kind: z.literal("king-of-the-hill"),
        hill: cell.extend({ radius: z.number().int().min(1) }),
        spawns: starts
    }),
    z.object({ kind: z.literal("team-duel"), teams: z.tuple([starts, starts]) }),
    z.object({ kind: z.literal("hide-and-seek"), seeker: cell, hiders: starts })
]);

export type ArenaContract = z.infer<typeof arenaContractSchema>;
export type Cell = z.infer<typeof cell>;

export interface ArenaEntry {
    readonly build: ArenaBuild;
    readonly contract: ArenaContract;
}

/** What a player cannot stand on: it has no top a foot stays on. */
const NOT_GROUND =
    /(carpet|_sign|_banner|torch|_button|lever|ladder|vine|rail|pressure_plate|flower|sapling|tripwire|redstone_wire|cobweb|fire|^minecraft:snow)$/;

/** Blocks that power redstone: none may be in a TNT run's build. */
export const POWER_SOURCES = [
    "minecraft:redstone_block",
    "minecraft:lever",
    "minecraft:redstone_torch",
    "minecraft:redstone_wall_torch",
    "minecraft:daylight_detector",
    "minecraft:observer",
    "minecraft:target",
    "minecraft:tripwire_hook",
    "minecraft:lightning_rod",
    "minecraft:sculk_sensor",
    "minecraft:calibrated_sculk_sensor",
    "minecraft:trapped_chest",
    "minecraft:comparator",
    "minecraft:repeater",
    "minecraft:redstone_wire"
] as const;

const isPower = (block: string) =>
    (POWER_SOURCES as readonly string[]).includes(block) || /_button$|_pressure_plate$/.test(block);

const t = (x: number, y: number, z: number): Cell => ({ x, y, z });
const row = (y: number, ...xz: [number, number][]) => xz.map(([x, z]) => t(x, y, z));
const TNT_BREAKABLE = [...tntRun.TOPPINGS, tntRun.FLOOR];
const square = (y: number, low: number, high: number, cells: number) => ({
    y,
    x1: low,
    z1: low,
    x2: high,
    z2: high,
    cells
});

/** Every entry as converted, before its contract is checked. */
const DECLARED: readonly { build: unknown; contract: ArenaContract }[] = [
    {
        build: spleefTower,
        contract: {
            kind: "spleef",
            breakable: ["minecraft:snow_block"],
            floors: [36, 30, 24, 18, 12].map((y) => square(y, 6, 26, 348)),
            spawns: row(
                37,
                [22, 16],
                [20, 20],
                [16, 22],
                [12, 20],
                [10, 16],
                [12, 12],
                [16, 10],
                [20, 12]
            )
        }
    },
    {
        build: spleefFrozenGarden,
        contract: {
            kind: "spleef",
            breakable: ["minecraft:snow_block"],
            floors: [{ y: 0, x1: 1, z1: 1, x2: 26, z2: 32, cells: 832 }],
            spawns: row(
                1,
                [21, 16],
                [19, 22],
                [13, 24],
                [8, 22],
                [6, 16],
                [8, 11],
                [13, 9],
                [19, 11]
            )
        }
    },
    {
        build: tntRunTemple,
        contract: {
            kind: "tnt-run",
            breakable: TNT_BREAKABLE,
            floors: [
                ...[36, 28, 20].map((y) => ({ y, x1: 3, z1: 2, x2: 32, z2: 31, cells: 744 })),
                { y: 12, x1: 3, z1: 2, x2: 32, z2: 31, cells: 779 }
            ],
            spawns: row(
                37,
                [26, 16],
                [24, 23],
                [17, 25],
                [11, 23],
                [9, 16],
                [11, 14],
                [17, 8],
                [24, 10]
            )
        }
    },
    {
        build: tntRunTower,
        contract: {
            kind: "tnt-run",
            breakable: TNT_BREAKABLE,
            floors: [57, 51, 45, 39, 33, 27, 21, 15, 9].map((y) => square(y, 3, 21, 293)),
            spawns: row(
                58,
                [17, 12],
                [16, 16],
                [12, 17],
                [8, 16],
                [7, 12],
                [8, 8],
                [12, 7],
                [16, 8]
            )
        }
    },
    {
        build: hillGlassPeak,
        contract: {
            kind: "king-of-the-hill",
            hill: { x: 13, y: 12, z: 16, radius: 2 },
            spawns: [
                t(21, 2, 17),
                t(19, 2, 23),
                t(12, 1, 26),
                t(8, 1, 21),
                t(7, 2, 16),
                t(7, 1, 10),
                t(13, 2, 7),
                t(19, 1, 10)
            ]
        }
    },
    {
        build: duelMudworks,
        contract: {
            kind: "team-duel",
            teams: [
                row(1, [13, 21], [13, 19], [13, 23], [13, 17]),
                row(1, [37, 21], [37, 19], [37, 23], [37, 17])
            ]
        }
    },
    {
        build: seekForestVillage,
        contract: {
            kind: "hide-and-seek",
            seeker: t(29, 21, 12),
            hiders: row(21, [63, 38], [44, 54], [22, 57], [9, 32], [23, 14], [45, 9])
        }
    }
];

/** The block at a cell of `build`, and whether a player stands at a cell. */
function reader(build: ArenaBuild) {
    const cells = decodeCells(build);
    const { x: width, y: height, z: depth } = build.size;
    const block = (x: number, y: number, z: number): string =>
        x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth
            ? AIR
            : blockOf(build.palette[cells[(y * depth + z) * width + x]!]!);
    const stands = (one: Cell) =>
        one.y >= 1 &&
        block(one.x, one.y - 1, one.z) !== AIR &&
        !NOT_GROUND.test(block(one.x, one.y - 1, one.z)) &&
        block(one.x, one.y, one.z) === AIR &&
        block(one.x, one.y + 1, one.z) === AIR;
    return { block, stands };
}

/** Why an entry's build does not keep its contract; empty when it does. */
export function contractProblems(build: ArenaBuild, contract: ArenaContract): string[] {
    const { block, stands } = reader(build);
    const problems: string[] = [];
    const startsOn = (label: string, list: readonly Cell[]) => {
        for (const one of list)
            if (!stands(one)) problems.push(`${label} ${one.x},${one.y},${one.z} has no footing`);
    };
    switch (contract.kind) {
        case "spleef":
        case "tnt-run": {
            const breakable = new Set(contract.breakable);
            contract.floors.forEach((one, index) => {
                if (index > 0 && one.y >= contract.floors[index - 1]!.y)
                    problems.push(`floor ${one.y} is not under the one before it`);
                let found = 0;
                for (let z = one.z1; z <= one.z2; z += 1)
                    for (let x = one.x1; x <= one.x2; x += 1)
                        if (breakable.has(block(x, one.y, z))) found += 1;
                if (found !== one.cells)
                    problems.push(`floor ${one.y} has ${found} breakable cells, not ${one.cells}`);
            });
            startsOn("spawn", contract.spawns);
            const top = contract.floors[0]!;
            for (const one of contract.spawns)
                if (one.y !== top.y + 1 || !breakable.has(block(one.x, top.y, one.z)))
                    problems.push(`spawn ${one.x},${one.y},${one.z} is not on the top floor`);
            if (contract.kind === "tnt-run")
                for (const state of build.palette)
                    if (isPower(blockOf(state)))
                        problems.push(`${blockOf(state)} could prime the TNT`);
            break;
        }
        case "king-of-the-hill": {
            const { hill } = contract;
            let ground = 0;
            for (let dz = -hill.radius; dz <= hill.radius; dz += 1)
                for (let dx = -hill.radius; dx <= hill.radius; dx += 1)
                    if (
                        Math.hypot(dx, dz) <= hill.radius &&
                        stands(t(hill.x + dx, hill.y, hill.z + dz))
                    )
                        ground += 1;
            if (ground < 4) problems.push(`the hill's zone has ${ground} cells to stand on`);
            startsOn("spawn", contract.spawns);
            for (const one of contract.spawns)
                if (one.y >= hill.y)
                    problems.push(`spawn ${one.x},${one.y},${one.z} is not below the hill`);
            break;
        }
        case "team-duel": {
            contract.teams.forEach((team, index) => startsOn(`team ${index + 1}`, team));
            const [one, other] = contract.teams.map((team) => ({
                x: team.reduce((sum, at) => sum + at.x, 0) / team.length,
                z: team.reduce((sum, at) => sum + at.z, 0) / team.length
            }));
            if (
                Math.hypot(one!.x - other!.x, one!.z - other!.z) <
                Math.max(build.size.x, build.size.z) / 3
            )
                problems.push("the teams do not start at opposite ends");
            break;
        }
        case "hide-and-seek":
            startsOn("seeker", [contract.seeker]);
            startsOn("hider", contract.hiders);
            break;
    }
    return problems;
}

/** The arenas from builds, each one checked: one that breaks its contract is not here. */
export const ARENA_BUILDS: readonly ArenaEntry[] = DECLARED.flatMap((one) => {
    const build = arenaBuildSchema.safeParse(one.build);
    const contract = arenaContractSchema.safeParse(one.contract);
    if (!build.success || !contract.success) return [];
    return contractProblems(build.data, contract.data).length === 0
        ? [{ build: build.data, contract: contract.data }]
        : [];
});

/** Every declared entry, checked or not: what the tests read. */
export function declaredArenas(): readonly { build: unknown; contract: ArenaContract }[] {
    return DECLARED;
}

/** The builds an event kind may be played on. */
export function arenaBuildsFor(kind: EventKind): readonly ArenaEntry[] {
    return ARENA_BUILDS.filter((one) => one.contract.kind === kind);
}

/**
 * The layout a run is played on: the generated arena (null) or one of the
 * kind's builds, drawn from the run's id - the same run always gets the same.
 */
export function arenaLayoutFor(
    kind: EventKind,
    runId: string,
    entries: readonly ArenaEntry[] = arenaBuildsFor(kind)
): ArenaEntry | null {
    if (entries.length === 0) return null;
    const drawn = shuffled([null, ...entries], seeded(`${runId}-arena-layout`))[0];
    return drawn ?? null;
}

/** A contract's cells in the world, for a build pasted with its lowest corner at `origin`. */
export function contractAt(contract: ArenaContract, origin: Point): ArenaContract {
    const at = (one: Cell): Cell => ({
        x: one.x + origin.x,
        y: one.y + origin.y,
        z: one.z + origin.z
    });
    switch (contract.kind) {
        case "spleef":
        case "tnt-run":
            return {
                ...contract,
                floors: contract.floors.map((one) => ({
                    ...one,
                    y: one.y + origin.y,
                    x1: one.x1 + origin.x,
                    z1: one.z1 + origin.z,
                    x2: one.x2 + origin.x,
                    z2: one.z2 + origin.z
                })),
                spawns: contract.spawns.map(at)
            };
        case "king-of-the-hill":
            return {
                ...contract,
                hill: { ...at(contract.hill), radius: contract.hill.radius },
                spawns: contract.spawns.map(at)
            };
        case "team-duel":
            return { ...contract, teams: [contract.teams[0].map(at), contract.teams[1].map(at)] };
        case "hide-and-seek":
            return { ...contract, seeker: at(contract.seeker), hiders: contract.hiders.map(at) };
    }
}

/** The id of the build a run of `kind` is played on, or null for the generated
 *  arena: what is written down as it is placed (`StageState.layout`). */
export function layoutIdFor(kind: EventKind, runId: string): string | null {
    return arenaLayoutFor(kind, runId)?.build.id ?? null;
}

/** A spleef's or TNT run's build by its id; null for one no longer shipped. */
export function floorEntryOf(kind: EventKind, id: string): ArenaEntry | null {
    return (
        ARENA_BUILDS.find(
            (one) =>
                one.build.id === id &&
                one.contract.kind === kind &&
                (kind === "spleef" || kind === "tnt-run")
        ) ?? null
    );
}

/** Where on the way from one start to the next each further lap of players
 *  goes once every start is taken: halfway first, then the quarters, then the
 *  eighths. */
const LAPS = [1 / 2, 1 / 4, 3 / 4, 1 / 8, 5 / 8, 3 / 8, 7 / 8] as const;
const spread = new WeakMap<ArenaEntry, readonly Cell[]>();

/**
 * Every cell a spleef's or TNT run's build starts a player on, in the order
 * they are taken: its own starts, then the cells between one and the next
 * (`LAPS`) that stand on the top floor's breakable blocks - so more players
 * than it has starts are not put on a cell another already holds.
 */
export function floorStarts(entry: ArenaEntry): readonly Cell[] {
    const { contract, build } = entry;
    if (contract.kind !== "spleef" && contract.kind !== "tnt-run") return [];
    const known = spread.get(entry);
    if (known) return known;
    const { block, stands } = reader(build);
    const breakable = new Set(contract.breakable);
    const top = contract.floors[0]!.y;
    const starts = contract.spawns;
    const taken = new Set(starts.map((one) => `${one.x},${one.z}`));
    const cells: Cell[] = [...starts];
    for (const lap of LAPS)
        starts.forEach((from, index) => {
            const to = starts[(index + 1) % starts.length]!;
            const one = t(
                Math.round(from.x + (to.x - from.x) * lap),
                top + 1,
                Math.round(from.z + (to.z - from.z) * lap)
            );
            const key = `${one.x},${one.z}`;
            if (taken.has(key) || !stands(one) || !breakable.has(block(one.x, top, one.z))) return;
            taken.add(key);
            cells.push(one);
        });
    spread.set(entry, cells);
    return cells;
}

/** How far under a build played in the air its catch net is. */
export const NET_DROP = 2;
/** How far the net reaches past the build on every side: a build has no walls
 *  of Polaris's own, so a jump off its edge lands on the net, not the ground. */
export const NET_MARGIN = 4;
/** The net: glass a fall lands on, as under a generated floor. */
export const NET_BLOCK: Box["block"] = "minecraft:white_stained_glass";
/** Room over the top floor for jumping about, as a generated floor has. */
const HEADROOM = 5;

/** A spleef or TNT run played on a build: the arena the game reads, what pastes it,
 *  and the marks its event pack is told apart by (`spleef.floorMarks`). */
export interface FloorBuild {
    readonly arena: spleef.Arena;
    readonly paste: readonly PastePiece[];
    readonly marks: readonly Box[];
}

/**
 * A spleef's or TNT run's build placed over `site`, its lowest layer at `y`:
 * its floors centered on the site, a glass net `NET_DROP` under the whole of it
 * and `NET_MARGIN` past every edge, so a fall past its last floor or off its
 * side lands on something - never the void - and is then out and sent home
 * (`spleef.fell`, `stage-service`'s `sendHome`); and the volume proved empty
 * taking in the build, the net, the square the floors close in from
 * (`spleef.shrinkLines`) and room over the top.
 */
export function floorArena(
    entry: ArenaEntry,
    site: { x: number; z: number },
    y: number
): FloorBuild {
    const { contract, build } = entry;
    if (contract.kind !== "spleef" && contract.kind !== "tnt-run")
        throw new Error(`${build.id} is not a spleef or TNT run build`);
    const low = {
        x: Math.min(...contract.floors.map((one) => one.x1)),
        z: Math.min(...contract.floors.map((one) => one.z1))
    };
    const high = {
        x: Math.max(...contract.floors.map((one) => one.x2)),
        z: Math.max(...contract.floors.map((one) => one.z2))
    };
    const middle = { x: Math.floor((low.x + high.x) / 2), z: Math.floor((low.z + high.z) / 2) };
    const size = Math.max(middle.x - low.x, high.x - middle.x, middle.z - low.z, high.z - middle.z);
    const outer = size + 1;
    const origin: Point = { x: site.x - middle.x, y, z: site.z - middle.z };
    const floors = contract.floors.map((one) => one.y + y);
    const top = floors[0]!;
    const x1 = Math.min(origin.x, site.x - outer) - NET_MARGIN;
    const z1 = Math.min(origin.z, site.z - outer) - NET_MARGIN;
    const x2 = Math.max(origin.x + build.size.x - 1, site.x + outer) + NET_MARGIN;
    const z2 = Math.max(origin.z + build.size.z - 1, site.z + outer) + NET_MARGIN;
    const net: Box = { x1, y1: y - NET_DROP, z1, x2, y2: y - NET_DROP, z2, block: NET_BLOCK };
    const arena: spleef.Arena = {
        floor: top,
        floors,
        center: { x: site.x, z: site.z },
        size,
        boxes: [net],
        volume: {
            x1,
            y1: y - NET_DROP,
            z1,
            x2,
            y2: Math.max(y + build.size.y - 1, top + HEADROOM),
            z2
        },
        reach: Math.ceil(Math.SQRT2 * Math.max(site.x - x1, x2 - site.x, site.z - z1, z2 - site.z)),
        starts: floorStarts(entry).map((one) => ({
            x: one.x + origin.x,
            y: one.y + origin.y,
            z: one.z + origin.z
        }))
    };
    return {
        arena,
        paste: pastePieces(build, origin),
        marks: spleef.floorMarks(arena, contract.kind === "spleef" ? spleef.FLOOR : tntRun.FLOOR)
    };
}
