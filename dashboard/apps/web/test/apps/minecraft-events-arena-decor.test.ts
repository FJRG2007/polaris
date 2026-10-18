/**
 * Every arena an event builds, dressed for Halloween and winter
 * (`kinds/arena-decor`), exactly as its build works the pieces out - the
 * stage's (`stage-service.stageDecor`), the arena's (`arena-service.arenaDecor`),
 * the hill's (`hill.platformPieces`) and the boss's (`boss.arenaDecor`):
 *
 * - nothing at all out of season;
 * - every piece off where anybody plays - on a post, a light over a wall, the
 *   rim of a pad, a corner - inside the air proved for the arena, in air of its
 *   own or in place of the one wall block it names;
 * - no block that falls, no cobweb where somebody races, flies or falls past,
 *   nothing that burns where there is fire, lava or lightning;
 * - each line a vanilla `fill ... keep` or `fill ... replace`, with nothing the
 *   server's version does not have;
 * - and every piece taken down again by the teardown that reads the state
 *   back after a restart, before the block it stands on.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as boss from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boss";
import * as hill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill";
import { arenaSchema } from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as sw from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars";
import * as spleef from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef";
import * as duel from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/team-duel";
import * as tntRun from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tnt-run";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import * as parkour from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour";
import * as dropper from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/dropper";
import * as decor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-decor";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";
import * as build from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/build-battle";
import * as acidRain from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/acid-rain";
import * as glass from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/glass-bridge";
import * as netherMaze from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/nether-maze";
import * as elytraRace from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/elytra-race";
import * as stageService from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage-service";
import * as arenaService from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-service";

const SITE = { x: 300, y: 120, z: -120 };
const SEEDS = 4;

const NEWEST: decor.Era = { lanterns: true, soulLanterns: true };
const ERAS: readonly decor.Era[] = [
    { lanterns: false, soulLanterns: false },
    { lanterns: true, soulLanterns: false },
    NEWEST
];
const SEASONS = ["halloween", "winter"] as const;

/** Blocks that burn or catch fire. */
const BURNS = /_(wool|carpet|log|leaves)$/;
/** Blocks that fall, snow among them: never one of the season's. */
const FALLS = /(sand|gravel|concrete_powder|anvil|snow|scaffolding|dripstone)/;

type Solid = decor.Solid;

/** A box of `own` holding the cell, or null for air - as `fitted` reads it. */
function ownAt(own: readonly Solid[], x: number, y: number, z: number): string | null {
    const found = own.find(
        (one) =>
            x >= Math.min(one.x1, one.x2) &&
            x <= Math.max(one.x1, one.x2) &&
            y >= Math.min(one.y1, one.y2) &&
            y <= Math.max(one.y1, one.y2) &&
            z >= Math.min(one.z1, one.z2) &&
            z <= Math.max(one.z1, one.z2)
    );
    return found ? decor.bareId(found.block) : null;
}

function inside(box: decor.Bounds, piece: decor.Piece): boolean {
    return (
        piece.x >= Math.min(box.x1, box.x2) &&
        piece.x <= Math.max(box.x1, box.x2) &&
        piece.y >= Math.min(box.y1, box.y2) &&
        piece.y <= Math.max(box.y1, box.y2) &&
        piece.z >= Math.min(box.z1, box.z2) &&
        piece.z <= Math.max(box.z1, box.z2)
    );
}

/** The arena's block a piece rests on: under the lowest piece of its column. */
function support(own: readonly Solid[], pieces: readonly decor.Piece[], piece: decor.Piece) {
    let y = piece.y - 1;
    while (pieces.some((one) => one.x === piece.x && one.z === piece.z && one.y === y)) y -= 1;
    return ownAt(own, piece.x, y, piece.z);
}

function run(
    kind: catalog.EventKind,
    options: Record<string, unknown> = {},
    id = "run-1",
    joined = 6
) {
    const preset = catalog.newPreset(kind, "test");
    return {
        id,
        preset: { ...preset, options: { ...preset.options, ...options } },
        joined: Array.from({ length: joined }, (_, index) => `Player${index}`),
        place: SITE,
        stage: null,
        arena: null
    } as never;
}

interface Case {
    readonly name: string;
    /** The pieces its build works out for a season and an era. */
    pieces(dressing: decor.Dressing | null): decor.Piece[];
    readonly own: readonly Solid[];
    readonly volume: decor.Bounds;
    readonly rules: decor.Rules;
    /** What a piece may rest on, or be put in place of. */
    readonly on: readonly string[];
    /** Why a piece is somewhere it must not be; null when it is not. */
    misplaced(piece: decor.Piece, pieces: readonly decor.Piece[]): string | null;
    readonly teardown: { kind: "stage" } | { kind: "arena"; blocks: readonly string[] };
}

const ids = (...names: string[]) => names.map((one) => `minecraft:${one}`);

/** A stage kind, worked out the way `stage-service.raise` does. */
function stageCase(
    name: string,
    kindRun: never,
    rules: decor.Rules,
    on: readonly string[],
    misplaced: Case["misplaced"]
): Case {
    const layout = stageService.stageLayout(kindRun, SITE);
    return {
        name,
        pieces: (dressing) => stageService.stageDecor(kindRun, SITE, dressing),
        own: layout.boxes,
        volume: layout.volume,
        rules,
        on,
        misplaced,
        teardown: { kind: "stage" }
    };
}

/** An arena kind, worked out the way `arena-service.raise` does. */
function arenaCase(
    name: string,
    kindRun: never,
    on: readonly string[],
    misplaced: Case["misplaced"]
): Case {
    const { preset } = kindRun as { preset: catalog.EventPreset };
    const game = gameOf(preset.kind);
    const players = (kindRun as { joined: string[] }).joined.length;
    const plot = (preset.options as { plotSize?: number }).plotSize ?? 0;
    const box = game
        ? game.box(kindRun, SITE)
        : preset.kind === "team-duel"
          ? duel.duelBox(SITE, SITE.y)
          : build.platformBox(SITE, SITE.y, players, plot);
    const withBox = { ...(kindRun as object), arena: { box } } as never;
    const fills = game
        ? game.fills(withBox, box)
        : preset.kind === "team-duel"
          ? duel.duelFills(box)
          : build.platformFills(box, players, plot);
    return {
        name,
        pieces: (dressing) => arenaService.arenaDecor(withBox, box, fills, dressing),
        own: fills.map((one) => ({ ...one.box, block: one.block })),
        volume: box,
        rules: game?.decorRules ?? {},
        on,
        misplaced,
        teardown: {
            kind: "arena",
            blocks: game
                ? game.blocks(withBox, box)
                : preset.kind === "team-duel"
                  ? duel.DUEL_BLOCKS
                  : build.PLATFORM_BLOCKS
        }
    };
}

const cases: Case[] = [];

// Spleef and TNT run: on the light over each corner of the walls, outside the floors.
for (const size of [8, 14, 20]) {
    const kindRun = run("spleef", { size });
    const built = spleef.arena(
        { ...catalog.newPreset("spleef", "t").options, size } as never,
        SITE,
        SITE.y
    );
    cases.push(
        stageCase(`spleef, size ${size}`, kindRun, {}, ids("sea_lantern"), (piece) =>
            Math.abs(piece.x - built.center.x) <= built.size &&
            Math.abs(piece.z - built.center.z) <= built.size
                ? "over a floor"
                : null
        )
    );
}
for (const layers of [1, 2, 3]) {
    const kindRun = run("tnt-run", { layers });
    const built = tntRun.arena(
        { ...catalog.newPreset("tnt-run", "t").options, layers } as never,
        SITE,
        SITE.y
    );
    cases.push(
        stageCase(
            `TNT run, ${layers} layers`,
            kindRun,
            { fireproof: true },
            ids("sea_lantern"),
            (piece) =>
                Math.abs(piece.x - built.center.x) <= built.size &&
                Math.abs(piece.z - built.center.z) <= built.size
                    ? "over a floor"
                    : null
        )
    );
}
// Parkour: on the net's corners, under every platform.
for (const difficulty of ["easy", "medium", "hard"] as const)
    for (let seed = 0; seed < SEEDS; seed += 1) {
        const kindRun = run("parkour", { difficulty }, `run-${seed}`);
        const course = parkour.course(
            { ...catalog.newPreset("parkour", "t").options, difficulty } as never,
            `run-${seed}`,
            SITE,
            SITE.y
        );
        cases.push(
            stageCase(
                `parkour, ${difficulty} ${seed}`,
                kindRun,
                { exposed: true },
                ids("white_stained_glass"),
                (piece) => (piece.y + 1 >= course.floor ? "level with the course" : null)
            )
        );
    }
// The dropper: on the lights over the rail, outside the shaft.
for (let seed = 0; seed < SEEDS; seed += 1) {
    const kindRun = run("dropper", {}, `run-${seed}`);
    const shaft = dropper.shaft(
        catalog.newPreset("dropper", "t").options as never,
        `run-${seed}`,
        SITE,
        SITE.y
    );
    cases.push(
        stageCase(`the dropper ${seed}`, kindRun, { exposed: true }, ids("sea_lantern"), (piece) =>
            Math.max(Math.abs(piece.x - shaft.center.x), Math.abs(piece.z - shaft.center.z)) <=
                dropper.HALF || piece.y <= shaft.top
                ? "in the shaft"
                : null
        )
    );
}
// Boat races, downhill too: on top of the gates' posts, over the arch.
for (const kind of ["boat-race", "downhill-race"] as const)
    for (let seed = 0; seed < SEEDS; seed += 1) {
        const kindRun = run(kind, {}, `run-${seed}`);
        const own = stageService.stageLayout(kindRun, SITE).boxes;
        cases.push(
            stageCase(
                `the ${kind} ${seed}`,
                kindRun,
                { exposed: true },
                ids("quartz_block"),
                (piece, pieces) => {
                    let y = piece.y - 1;
                    while (
                        pieces.some((one) => one.x === piece.x && one.z === piece.z && one.y === y)
                    )
                        y -= 1;
                    // A post at least three high: the arch boats pass under.
                    for (let down = 0; down < 3; down += 1)
                        if (ownAt(own, piece.x, y - down, piece.z) !== "minecraft:quartz_block")
                            return "not on a gate's post";
                    return null;
                }
            )
        );
    }
// The nether maze: the starting room's corners furthest from its door, never in the maze.
for (const size of ["small", "medium", "large"] as const)
    for (let seed = 0; seed < 3; seed += 1) {
        const kindRun = run("nether-maze", { size }, `run-${seed}`);
        const maze = netherMaze.maze(
            { ...catalog.newPreset("nether-maze", "t").options, size } as never,
            `run-${seed}`,
            SITE,
            SITE.y
        );
        const own = stageService.stageLayout(kindRun, SITE).boxes;
        cases.push(
            stageCase(
                `the nether maze, ${size} ${seed}`,
                kindRun,
                { fireproof: true, exposed: true },
                ids("nether_bricks"),
                (piece) => {
                    const tile = maze.plan.tiles.get(
                        `${piece.x - maze.origin.x},${piece.z - maze.origin.z}`
                    );
                    if (tile !== "start") return `in the maze (${tile})`;
                    const walls = [
                        [1, 0],
                        [-1, 0],
                        [0, 1],
                        [0, -1]
                    ].filter(
                        ([dx, dz]) => ownAt(own, piece.x + dx!, piece.y, piece.z + dz!) !== null
                    );
                    return walls.length >= 2 ? null : "not in a corner";
                }
            )
        );
    }
// Acid rain: on the light in each corner of the floor, against two walls.
for (const size of ["small", "medium", "large"] as const) {
    const kindRun = run("acid-rain", { size });
    const own = stageService.stageLayout(kindRun, SITE).boxes;
    const acid = acidRain.arena(
        { ...catalog.newPreset("acid-rain", "t").options, size } as never,
        "run-1",
        SITE,
        SITE.y
    );
    cases.push(
        stageCase(
            `acid rain, ${size}`,
            kindRun,
            { fireproof: true, exposed: true },
            ids("sea_lantern"),
            (piece) => {
                if (
                    Math.abs(piece.x - acid.center.x) !== acid.half ||
                    Math.abs(piece.z - acid.center.z) !== acid.half
                )
                    return "not in a corner";
                const walls = [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ].filter(([dx, dz]) => ownAt(own, piece.x + dx!, piece.y, piece.z + dz!) !== null);
                return walls.length === 2 ? null : "not against the walls";
            }
        )
    );
}
// The elytra race: on the pad's rim, never on the pad, a ring or a pillar.
for (let seed = 0; seed < SEEDS; seed += 1) {
    const kindRun = run("elytra-race", {}, `run-${seed}`);
    const course = elytraRace.course(
        catalog.newPreset("elytra-race", "t").options as never,
        `run-${seed}`,
        SITE,
        SITE.y
    );
    const pad = course.pad;
    cases.push(
        stageCase(`the elytra race ${seed}`, kindRun, { exposed: true }, ids("glass"), (piece) =>
            piece.x >= pad.x1 && piece.x <= pad.x2 && piece.z >= pad.z1 && piece.z <= pad.z2
                ? "on the pad"
                : Math.abs(piece.x - pad.x1) > 1 && Math.abs(piece.x - pad.x2) > 1
                  ? "away from the pad"
                  : null
        )
    );
}
// The world boss's sky arena: set into its corner pillars of light.
{
    const volume = boss.arenaVolume(SITE);
    cases.push({
        name: "the world boss's arena",
        pieces: (dressing) => boss.arenaDecor(SITE, dressing),
        own: boss.arenaBoxes(SITE),
        volume,
        rules: { fireproof: true },
        on: ids("sea_lantern"),
        misplaced: (piece) =>
            (piece.x === volume.x1 || piece.x === volume.x2) &&
            (piece.z === volume.z1 || piece.z === volume.z2)
                ? null
                : "not in a corner's pillar",
        teardown: { kind: "stage" }
    });
}
// The king of the hill: a carpet on each corner of the plain platform.
for (const radius of [4, 8, 12]) {
    const half = radius + hill.MARGIN;
    const own = [
        ...hill.platformDecor(SITE, radius, hill.PLAIN),
        { box: hill.platformBox(SITE, radius), block: hill.PLAIN.floor }
    ].map((one) => ({ ...one.box, block: one.block }));
    cases.push({
        name: `the king of the hill, radius ${radius}`,
        pieces: (dressing) => hill.platformPieces(SITE, radius, hill.PLAIN, dressing, false),
        own,
        volume: hill.proofBox(SITE, radius, hill.PLAIN),
        rules: {},
        on: [hill.PLAIN.floor, ...own.map((one) => decor.bareId(one.block))],
        misplaced: (piece) =>
            Math.abs(piece.x - SITE.x) === half && Math.abs(piece.z - SITE.z) === half
                ? piece.block.endsWith("_carpet")
                    ? null
                    : "not a carpet"
                : "not on a corner",
        teardown: { kind: "arena", blocks: hill.PLATFORM_BLOCKS }
    });
}
// Duel, build battle and capture the flag: in the barrier over each corner's post.
const barrierCorner = (box: decor.Bounds) => (piece: decor.Piece) =>
    (piece.x === box.x1 || piece.x === box.x2) && (piece.z === box.z1 || piece.z === box.z2)
        ? null
        : "not on the box's corner";
for (const kind of ["team-duel", "build-battle", "capture-the-flag"] as const)
    for (const players of [2, 6, 12]) {
        const made = arenaCase(
            `${kind}, ${players} players`,
            run(kind, {}, "run-1", players),
            ids("barrier"),
            () => null
        );
        cases.push({ ...made, misplaced: barrierCorner(made.volume) });
    }
// Hot potato: on the lights topping the walls' corners.
for (const players of [2, 6, 12]) {
    const made = arenaCase(
        `hot potato, ${players} players`,
        run("hot-potato", {}, "run-1", players),
        ids("sea_lantern"),
        () => null
    );
    const box = made.volume;
    cases.push({
        ...made,
        misplaced: (piece) =>
            piece.y - Math.min(box.y1, box.y2) < 4
                ? "within reach of the floor"
                : (piece.x === box.x1 || piece.x === box.x2) &&
                    (piece.z === box.z1 || piece.z === box.z2)
                  ? null
                  : "not on a corner"
    });
}
// SkyWars: on the corners of the gallery's lid, over the fight.
for (const players of [2, 6, 12])
    for (let seed = 0; seed < SEEDS; seed += 1) {
        const kindRun = run("sky-wars", {}, `run-${seed}`, players);
        const made = arenaCase(
            `SkyWars, ${players} players ${seed}`,
            kindRun,
            ids("barrier"),
            () => null
        );
        const gallery = sw.galleryFloor(sw.layoutFor(`run-${seed}|${players}`, players), SITE);
        cases.push({
            ...made,
            misplaced: (piece) =>
                piece.y <= gallery.y1 + 1
                    ? "within the gallery's reach"
                    : piece.x >= gallery.x1 &&
                        piece.x <= gallery.x2 &&
                        piece.z >= gallery.z1 &&
                        piece.z <= gallery.z2
                      ? "over the gallery"
                      : null
        });
    }
// Impostor: high in a room's wall, a full block for the wall's.
for (const players of [4, 9, 15])
    for (let seed = 0; seed < SEEDS; seed += 1) {
        const made = arenaCase(
            `impostor, ${players} players ${seed}`,
            run("impostor", {}, `run-${seed}`, players),
            ids("light_gray_concrete"),
            () => null
        );
        cases.push({
            ...made,
            misplaced: (piece) =>
                piece.replaces === undefined
                    ? "not set in a wall"
                    : // The wall's top row, under the roof: over every head.
                      piece.y - made.volume.y1 >= 3 &&
                        ownAt(made.own, piece.x, piece.y + 1, piece.z) !== piece.replaces
                      ? null
                      : "not the top of a wall"
        });
    }
// The glass bridge: on the arches' pillars and along their beams, over everybody.
for (const steps of [6, 10, 16]) {
    const made = arenaCase(
        `the glass bridge, ${steps} steps`,
        run("glass-bridge", { steps }),
        ids("quartz_pillar", "smooth_quartz", "yellow_concrete"),
        () => null
    );
    const layout = glass.layoutOf(made.volume as never, steps);
    cases.push({
        ...made,
        misplaced: (piece) => (piece.y - layout.y < 4 ? "within reach of the bridge" : null)
    });
}
// Tug of war: on the lights over the pens' corners.
for (const ropeLength of [8, 12, 16]) {
    const made = arenaCase(
        `tug of war, rope ${ropeLength}`,
        run("tug-of-war", { ropeLength }),
        ids("sea_lantern"),
        () => null
    );
    cases.push({
        ...made,
        misplaced: (piece) =>
            piece.y - made.volume.y1 < 4 ||
            (piece.z !== made.volume.z1 && piece.z !== made.volume.z2)
                ? "within the pens"
                : null
    });
}

/** Every season and era an arena is dressed in. */
const dressings: decor.Dressing[] = SEASONS.flatMap((season) =>
    ERAS.map((era) => ({ season, era }))
);

describe("an event's arena dressed for the season", () => {
    it("covers every kind that builds one", () => {
        const kinds = [
            "spleef",
            "TNT run",
            "parkour",
            "the dropper",
            "the boat-race",
            "the downhill-race",
            "the nether maze",
            "acid rain",
            "the elytra race",
            "the world boss",
            "the king of the hill",
            "team-duel",
            "build-battle",
            "capture-the-flag",
            "hot potato",
            "SkyWars",
            "impostor",
            "the glass bridge",
            "tug of war"
        ];
        for (const kind of kinds)
            expect(
                cases.some((one) => one.name.startsWith(kind)),
                kind
            ).toBe(true);
    });

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: nothing out of season",
        (_name, one) => {
            expect(one.pieces(null)).toEqual([]);
        }
    );

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: every piece off the play, inside its air, and nothing that falls, burns or catches",
        (_name, one) => {
            for (const dressing of dressings) {
                const pieces = one.pieces(dressing);
                expect(pieces.length, `${dressing.season}`).toBeGreaterThan(0);
                expect(pieces.length).toBeLessThanOrEqual(decor.MOST_SPOTS * 3);
                const cells = new Set<string>();
                for (const piece of pieces) {
                    const where = `${piece.block} at ${piece.x} ${piece.y} ${piece.z}`;
                    expect(inside(one.volume, piece), where).toBe(true);
                    expect(cells.has(`${piece.x},${piece.y},${piece.z}`), where).toBe(false);
                    cells.add(`${piece.x},${piece.y},${piece.z}`);
                    expect(stage.falls(piece.block), where).toBe(false);
                    expect(FALLS.test(piece.block), where).toBe(false);
                    expect(decor.DECOR_BLOCKS as readonly string[], where).toContain(piece.block);
                    if (one.rules.exposed) expect(piece.block, where).not.toBe("minecraft:cobweb");
                    if (one.rules.fireproof)
                        expect(BURNS.test(decor.bareId(piece.block)), where).toBe(false);
                    if (piece.replaces) {
                        expect(ownAt(one.own, piece.x, piece.y, piece.z), where).toBe(
                            piece.replaces
                        );
                        expect(one.on, where).toContain(piece.replaces);
                    } else {
                        expect(ownAt(one.own, piece.x, piece.y, piece.z), where).toBeNull();
                        expect(one.on, where).toContain(support(one.own, pieces, piece));
                    }
                    expect(one.misplaced(piece, pieces), where).toBeNull();
                }
            }
        }
    );

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: vanilla fill lines, keep or replace, with what the version has",
        (_name, one) => {
            for (const dressing of dressings) {
                const pieces = one.pieces(dressing);
                const lines = decor.decorLines(pieces);
                expect(lines).toHaveLength(pieces.length);
                for (const [index, line] of lines.entries()) {
                    const piece = pieces[index]!;
                    const at = `${piece.x} ${piece.y} ${piece.z}`;
                    expect(line).toMatch(
                        /^execute in minecraft:overworld run fill (-?\d+ ){6}minecraft:[a-z_]+(\[[a-z_]+=[a-z_]+\])? (keep|replace minecraft:[a-z_]+)$/
                    );
                    expect(
                        line.startsWith(
                            `execute in minecraft:overworld run fill ${at} ${at} ${piece.block} `
                        )
                    ).toBe(true);
                    expect(
                        line.endsWith(piece.replaces ? `replace ${piece.replaces}` : " keep")
                    ).toBe(true);
                    // A lantern from 1.14, a soul lantern from 1.16.
                    if (!dressing.era.lanterns)
                        expect(piece.block).not.toMatch(/:(soul_)?lantern$/);
                    if (!dressing.era.soulLanterns)
                        expect(piece.block).not.toBe("minecraft:soul_lantern");
                }
                // Halloween in its colours, winter in its own: never the other's.
                const blocks = pieces.map((piece) => piece.block).join(" ");
                if (dressing.season === "halloween")
                    expect(blocks).not.toMatch(/red_|green_|spruce/);
                else expect(blocks).not.toMatch(/pumpkin|jack_o|cobweb|purple|black_|orange|soul/);
            }
        }
    );
});

/** A server that answers every fill as done, and keeps every line in order. */
function fakeServer() {
    const order: string[] = [];
    const answer = (line: string) =>
        line.includes(" fill ") ? "Successfully filled 1 block(s)" : "";
    const server = {
        installedAppId: `decor-${Math.random()}`,
        edition: "java",
        say: async (lines: readonly string[]) => {
            order.push(...lines);
            return answer(lines[0] ?? "");
        },
        sayAll: async (lines: readonly string[]) => {
            order.push(...lines);
        }
    } as unknown as ServerContainer;
    return { server, order };
}

const removal = (piece: decor.Piece, block: string) =>
    `execute in minecraft:overworld run fill ${piece.x} ${piece.y} ${piece.z} ${piece.x} ${piece.y} ${piece.z} minecraft:air replace ${block}`;

describe("an arena's season taken down with it", () => {
    it("lists every piece a stage can be among the blocks its state keeps", () => {
        // A block the schema did not know would fail the whole event state on read.
        for (const block of decor.DECOR_BLOCKS)
            expect(stage.ARENA_BLOCKS as readonly string[]).toContain(block);
    });

    const stageCases = cases.filter((one) => one.teardown.kind === "stage");
    const arenaCases = cases.filter((one) => one.teardown.kind === "arena");

    it.each(stageCases.map((one) => [one.name, one] as const))(
        "%s: every piece written down as a box, read back after a restart and taken out before what holds it",
        async (_name, one) => {
            for (const dressing of dressings) {
                const pieces = one.pieces(dressing);
                const boxes = [...(one.own as stage.Box[]), ...pieces.map(stageService.decorBox)];
                // What a restart reads back: the leftover through its schema.
                const leftover = stage.stageLeftoverSchema.parse(
                    JSON.parse(
                        JSON.stringify({
                            runId: "run-1",
                            area: null,
                            boxes,
                            saved: [],
                            proved: one.volume
                        })
                    )
                );
                expect(leftover.boxes).toEqual(boxes);
                const { server, order } = fakeServer();
                const left = await stageService.settle(
                    server,
                    leftover,
                    { items: "components", top: 319 },
                    "en"
                );
                expect(left).toBeNull();
                for (const piece of pieces) {
                    const gone = order.indexOf(removal(piece, piece.block));
                    expect(
                        gone,
                        `${piece.block} at ${piece.x} ${piece.y} ${piece.z}`
                    ).toBeGreaterThanOrEqual(0);
                    // Before any of the arena's own boxes comes out.
                    const firstOwn = order.findIndex((line) =>
                        (one.own as stage.Box[]).some((box) => line === stage.removeLine(box))
                    );
                    expect(gone).toBeLessThan(firstOwn);
                }
                // And the volume proved empty swept whole after it all.
                expect(order).toEqual(
                    expect.arrayContaining(stage.sweepFills(leftover.proved ?? one.volume))
                );
            }
        }
    );

    it.each(arenaCases.map((one) => [one.name, one] as const))(
        "%s: every piece's kind listed first, read back after a restart and taken out of the whole box",
        (_name, one) => {
            if (one.teardown.kind !== "arena") return;
            for (const dressing of dressings) {
                const pieces = one.pieces(dressing);
                const box = { ...(one.volume as stage.Volume) };
                const top = Math.max(box.y2, ...pieces.map((piece) => piece.y));
                // As `arena-service.raise` and `hill-service` write it down.
                const written = arenaSchema.parse(
                    JSON.parse(
                        JSON.stringify({
                            box: { ...box, y2: top },
                            blocks: [...new Set([...decor.idsOf(pieces), ...one.teardown.blocks])],
                            proved: one.volume
                        })
                    )
                );
                const lines = arena.teardown(written);
                for (const piece of pieces) {
                    const id = decor.bareId(piece.block);
                    const takes = lines.findIndex((line) => {
                        const match =
                            /fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:air replace (\S+)$/.exec(
                                line
                            );
                        if (!match || match[7] !== id) return false;
                        const [x1, y1, z1, x2, y2, z2] = match.slice(1, 7).map(Number) as number[];
                        return (
                            piece.x >= Math.min(x1!, x2!) &&
                            piece.x <= Math.max(x1!, x2!) &&
                            piece.y >= Math.min(y1!, y2!) &&
                            piece.y <= Math.max(y1!, y2!) &&
                            piece.z >= Math.min(z1!, z2!) &&
                            piece.z <= Math.max(z1!, z2!)
                        );
                    });
                    expect(
                        takes,
                        `${piece.block} at ${piece.x} ${piece.y} ${piece.z}`
                    ).toBeGreaterThanOrEqual(0);
                    // Before the block it stands on, or stands in place of.
                    const under = piece.replaces ?? support(one.own, pieces, piece);
                    const holder = lines.findIndex((line) => line.endsWith(` replace ${under}`));
                    if (holder >= 0) expect(takes).toBeLessThan(holder);
                }
            }
        }
    );
});

describe("the trim's teardown order", () => {
    it("takes a lantern first and a jack o'lantern with the full blocks", () => {
        const ids = decor.trimIds([
            "minecraft:jack_o_lantern",
            "minecraft:soul_lantern[hanging=true]",
            "minecraft:lantern"
        ]);
        expect(ids.first).toEqual(["minecraft:soul_lantern"]);
        expect(ids.last).toContain("minecraft:jack_o_lantern");
        const order = decor.TRIM_BLOCKS;
        const jack = order.indexOf("minecraft:jack_o_lantern");
        if (jack >= 0) {
            for (const lantern of ["minecraft:lantern", "minecraft:soul_lantern"]) {
                const at = order.indexOf(lantern);
                if (at >= 0) expect(at).toBeLessThan(jack);
            }
        }
    });
});
