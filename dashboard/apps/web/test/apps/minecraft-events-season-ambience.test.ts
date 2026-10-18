/**
 * An event in the season's colors and mood (`kinds/arena-decor` trim,
 * `season-ambience`), checked the way the builds and the play loop use them:
 *
 * - the trim swaps only the blocks a kind names as framing the game - never
 *   the snow, the TNT, the glass panels, an island's ground or its chests - in
 *   the same boxes, in the same order;
 * - every block the trim puts in is written down for the teardown: in
 *   `stage.ARENA_BLOCKS` for a stage, in the arena's own list (lanterns first)
 *   for an arena;
 * - the particles are drawn round a bounded number of players, seen only by
 *   those in the event, and only what the server's version has;
 * - the winner's fireworks are a bounded handful, written the way the
 *   version reads an item;
 * - and out of season every line is exactly what it was before.
 */

import { describe, expect, it } from "vitest";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as sw from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars";
import * as spleef from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef";
import * as tntRun from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tnt-run";
import * as decor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-decor";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";
import * as glass from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/glass-bridge";
import * as ambience from "@polaris-app/game-servers/src/lib/minecraft/events/season-ambience";
import * as stageService from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage-service";

const SITE = { x: 300, y: 120, z: -120 };
const SEASONS = ["halloween", "winter"] as const;
const ERAS: readonly decor.Era[] = [
    { lanterns: false, soulLanterns: false },
    { lanterns: true, soulLanterns: false },
    { lanterns: true, soulLanterns: true },
    { lanterns: true, soulLanterns: true, snowflakes: true },
    { lanterns: true, soulLanterns: true, snowflakes: true, components: true }
];
const NEWEST = ERAS.at(-1)!;
const DRESSINGS: decor.Dressing[] = SEASONS.flatMap((season) =>
    ERAS.map((era) => ({ season, era }))
);

function run(kind: catalog.EventKind, options: Record<string, unknown> = {}, joined = 6) {
    const preset = catalog.newPreset(kind, "test");
    return {
        id: "run-1",
        preset: { ...preset, options: { ...preset.options, ...options } },
        joined: Array.from({ length: joined }, (_, index) => `Player${index}`),
        entrants: [],
        place: SITE,
        stage: null,
        arena: null,
        readyAt: null,
        game: null,
        season: null
    } as never;
}

interface Built {
    readonly name: string;
    readonly trim: decor.Trim;
    /** What it is built of out of season. */
    readonly own: readonly { readonly block: string }[];
    /** What it is built of in a season. */
    dressed(dressing: decor.Dressing | null): readonly { readonly block: string }[];
    /** Blocks it is played on, which no season may touch. */
    readonly played: readonly string[];
    readonly teardown: "stage" | "arena";
    /** The kind's own list for its teardown (an arena's). */
    readonly blocks: readonly string[];
}

function stageCase(name: string, kindRun: never, trim: decor.Trim, played: string[]): Built {
    return {
        name,
        trim,
        own: stageService.stageLayout(kindRun, SITE).boxes,
        dressed: (dressing) => stageService.stageBoxes(kindRun, SITE, dressing),
        played,
        teardown: "stage",
        blocks: []
    };
}

function arenaCase(name: string, kindRun: never, played: string[]): Built {
    const { preset } = kindRun as { preset: catalog.EventPreset };
    const game = gameOf(preset.kind)!;
    const box = game.box(kindRun, SITE);
    const withBox = { ...(kindRun as object), arena: { box } } as never;
    const fills = game.fills(withBox, box);
    return {
        name,
        trim: game.trim!,
        own: fills,
        dressed: (dressing) => decor.trimFills(fills, game.trim, dressing),
        played,
        teardown: "arena",
        blocks: game.blocks(withBox, box).map(decor.bareId)
    };
}

const cases: Built[] = [
    ...[8, 14, 20].map((size) =>
        stageCase(`spleef, size ${size}`, run("spleef", { size }), spleef.TRIM, [
            "minecraft:snow_block",
            "minecraft:white_stained_glass"
        ])
    ),
    ...[1, 2, 3].map((layers) =>
        stageCase(`TNT run, ${layers} layers`, run("tnt-run", { layers }), tntRun.TRIM, [
            "minecraft:tnt",
            "minecraft:white_stained_glass"
        ])
    ),
    arenaCase("glass bridge", run("glass-bridge"), [glass.GLASS, "minecraft:barrier"]),
    arenaCase("sky wars", run("sky-wars"), [
        "minecraft:grass_block",
        "minecraft:dirt",
        "minecraft:stone",
        "minecraft:chest",
        "minecraft:barrier"
    ]),
    ...[false, true].map((middle) =>
        arenaCase(`pillars${middle ? ", with a middle" : ""}`, run("pillars", { middle }), [
            "minecraft:bedrock",
            "minecraft:gold_block",
            "minecraft:barrier"
        ])
    )
];

describe("the season's trim", () => {
    it.each(cases)("$name: only the framing blocks change, in the same boxes", (one) => {
        for (const dressing of DRESSINGS) {
            const dressed = one.dressed(dressing);
            expect(dressed).toHaveLength(one.own.length);
            dressed.forEach((box, index) => {
                const own = one.own[index]!;
                expect({ ...box, block: own.block }).toEqual(own);
                if (box.block === own.block) return;
                expect(Object.keys(one.trim)).toContain(own.block);
                expect(box.block).toBe(decor.trimmed(own.block, one.trim, dressing));
            });
        }
    });

    it.each(cases)("$name: nothing it is played on is ever named", (one) => {
        for (const block of one.played) expect(Object.keys(one.trim)).not.toContain(block);
    });

    it.each(cases)("$name: dressed in both seasons on the newest server", (one) => {
        for (const season of SEASONS) {
            const dressed = one.dressed({ season, era: NEWEST });
            expect(dressed.some((box, index) => box.block !== one.own[index]!.block)).toBe(true);
        }
    });

    it.each(cases)("$name: every block it puts in is written down for the teardown", (one) => {
        for (const dressing of DRESSINGS) {
            const dressed = one.dressed(dressing).map((box) => box.block);
            if (one.teardown === "stage") {
                for (const block of dressed) expect(stage.ARENA_BLOCKS).toContain(block);
                continue;
            }
            // As `arena-service.raise` writes its list: lanterns, the kind's, the rest.
            const trim = decor.trimIds(dressed);
            const listed = new Set([...trim.first, ...one.blocks, ...trim.last]);
            for (const block of dressed) expect(listed.has(decor.bareId(block))).toBe(true);
            for (const id of trim.first) expect(id.endsWith("lantern")).toBe(true);
            for (const id of trim.last) expect(id.endsWith("lantern")).toBe(false);
        }
    });

    it("never gives a soul block to a server older than 1.16", () => {
        for (const season of SEASONS)
            for (const era of ERAS.filter((one) => !one.soulLanterns))
                for (const one of cases)
                    for (const box of one.dressed({ season, era }))
                        expect(box.block).not.toMatch(/soul|blackstone|crying_obsidian/);
    });

    it("lists every block the trim can be, lanterns first", () => {
        const values = Object.values(decor.SEASON_TRIM)
            .flatMap((parts) => Object.values(parts))
            .flatMap((one) =>
                typeof one === "string" ? [one] : [one.soul, ...(one.before ? [one.before] : [])]
            )
            .map(decor.bareId);
        for (const id of values) expect(decor.TRIM_BLOCKS).toContain(id);
        const firstFull = decor.TRIM_BLOCKS.findIndex((id) => !id.endsWith("lantern"));
        expect(decor.TRIM_BLOCKS.slice(firstFull).some((id) => id.endsWith("lantern"))).toBe(false);
    });

    it("lets a bridging block go against a sky wars island in any season", () => {
        for (const dressing of DRESSINGS)
            for (const block of Object.keys(sw.TRIM))
                expect(sw.PLACE_ON).toContain(
                    decor.bareId(decor.trimmed(block, sw.TRIM, dressing))
                );
        expect(new Set(sw.PLACE_ON).size).toBe(sw.PLACE_ON.length);
    });

    it.each(cases)("$name: exactly as before out of season", (one) => {
        expect(one.dressed(null)).toEqual(one.own);
    });

    it("decorates a stage against the same cells in or out of season", () => {
        for (const one of [run("spleef", { size: 14 }), run("tnt-run", { layers: 3 })]) {
            const own = stageService.stageLayout(one, SITE).boxes;
            for (const dressing of DRESSINGS) {
                const pieces = stageService.stageDecor(one, SITE, dressing);
                const dressed = stageService.stageBoxes(one, SITE, dressing);
                for (const piece of pieces) {
                    if (piece.replaces === undefined) continue;
                    // A piece put in place of a wall names the wall as it is built.
                    expect(dressed.map((box) => decor.bareId(box.block))).toContain(
                        decor.bareId(piece.replaces)
                    );
                }
                expect(dressed.map(({ block, ...box }) => box)).toEqual(
                    own.map(({ block, ...box }) => box)
                );
            }
        }
    });
});

/** A run of one kind, dressed for `dressing`, at a point of its play. */
function playRun(
    kind: catalog.EventKind,
    dressing: decor.Dressing | null,
    readyAt: number | null,
    out: string[] = []
): stored.EventRun {
    const preset = catalog.newPreset(kind, "test");
    const box = { x1: 0, y1: 100, z1: 0, x2: 40, y2: 120, z2: 30 };
    return {
        id: "run-1",
        preset,
        season: dressing,
        readyAt,
        stage: null,
        arena: { box, blocks: [] },
        game: { out: out.map((name) => ({ name })) }
    } as never;
}

describe("the season's ambience", () => {
    const halloween: decor.Dressing = { season: "halloween", era: NEWEST };
    const winter: decor.Dressing = { season: "winter", era: NEWEST };

    it("is nothing at all out of season", () => {
        for (const kind of ambience.AMBIENT_KINDS) {
            const before = playRun(kind, null, null);
            const after = playRun(kind, null, 0, ["Player1"]);
            for (let now = 0; now < 10_000; now += 500)
                expect(ambience.tickLines(before, after, now, 500, "en")).toEqual([]);
            expect(ambience.winLines(after, "Player0", "en")).toEqual([]);
        }
    });

    it("is nothing for a kind it does not dress, in season or not", () => {
        const before = playRun("parkour", halloween, null);
        const after = playRun("parkour", halloween, 0);
        expect(ambience.tickLines(before, after, 2_000, 500, "en")).toEqual([]);
        expect(ambience.winLines(after, "Player0", "en")).toEqual([]);
    });

    it("tells those in it by the tag their kind gives them", () => {
        expect(ambience.inTag(playRun("spleef", winter, 0))).toBe(stage.IN_ARENA);
        expect(ambience.inTag(playRun("tnt-run", winter, 0))).toBe(stage.IN_ARENA);
        for (const kind of ["glass-bridge", "sky-wars", "pillars"] as const)
            expect(ambience.inTag(playRun(kind, winter, 0))).toBe(arena.IN_ARENA);
        const start = ambience.tickLines(
            playRun("pillars", winter, null),
            playRun("pillars", winter, 0),
            2_000,
            500,
            "en"
        );
        expect(start.length).toBeGreaterThan(1);
        for (const line of start.slice(1)) expect(line).toContain(`@a[tag=${arena.IN_ARENA}`);
    });

    it("draws the particles round a bounded few, seen only by those in it", () => {
        for (const dressing of DRESSINGS) {
            const lines = ambience.particleLines(dressing, stage.IN_ARENA);
            expect(lines.length).toBeGreaterThan(0);
            for (const line of lines) {
                expect(line).toContain(
                    `execute as @a[tag=${stage.IN_ARENA},limit=${ambience.MOST_SHOWN}] at @s run particle `
                );
                expect(line.endsWith(` normal @a[tag=${stage.IN_ARENA}]`)).toBe(true);
                const count = Number(line.split(" ").at(-3));
                expect(count).toBeGreaterThan(0);
                expect(count).toBeLessThanOrEqual(12);
            }
        }
        expect(ambience.MOST_SHOWN).toBeLessThanOrEqual(24);
    });

    it("draws them once every stretch, whatever the tick", () => {
        const before = playRun("spleef", winter, 0);
        for (const tick of [250, 500, 1_000]) {
            let looks = 0;
            for (let now = tick; now <= 20_000; now += tick)
                if (
                    ambience
                        .tickLines(before, before, now, tick, "en")
                        .some((line) => line.includes(" run particle "))
                )
                    looks += 1;
            expect(looks).toBe(20_000 / ambience.AMBIENCE_MS);
        }
    });

    it("shows only what the server's version has", () => {
        const text = (era: decor.Era, season: decor.Dressing["season"]) =>
            ambience.particleLines({ season, era }, stage.IN_ARENA).join("\n");
        expect(text({ lanterns: true, soulLanterns: false }, "halloween")).not.toContain("soul");
        expect(text({ lanterns: true, soulLanterns: true }, "halloween")).toContain(
            "minecraft:soul "
        );
        expect(text({ lanterns: true, soulLanterns: true }, "winter")).not.toContain("snowflake");
        expect(text({ lanterns: true, soulLanterns: true }, "winter")).toContain(
            "minecraft:item_snowball"
        );
        expect(text({ lanterns: true, soulLanterns: true, snowflakes: true }, "winter")).toContain(
            "minecraft:snowflake"
        );
    });

    it("greets them as it starts, and marks each look somebody goes out", () => {
        const waiting = playRun("tnt-run", halloween, null);
        const started = playRun("tnt-run", halloween, 0);
        const oneOut = playRun("tnt-run", halloween, 0, ["Player1"]);
        expect(ambience.tickLines(waiting, waiting, 100, 100, "en")).toEqual([
            ambience.barColorLine(halloween, 100)
        ]);
        const start = ambience.tickLines(waiting, started, 100, 100, "en");
        expect(start.some((line) => line.startsWith(`tellraw @a[tag=${stage.IN_ARENA}]`))).toBe(
            true
        );
        expect(start.some((line) => line.includes("block.bell.resonate"))).toBe(true);
        const out = ambience.tickLines(started, oneOut, 100, 100, "en");
        expect(out).toEqual([
            ambience.barColorLine(halloween, 100),
            ...ambience.outLines(halloween, stage.IN_ARENA)
        ]);
        expect(ambience.tickLines(oneOut, oneOut, 100, 100, "en")).toEqual([
            ambience.barColorLine(halloween, 100)
        ]);
    });

    it("turns the bar purple, or red and green by turns", () => {
        expect(ambience.barColorLine(halloween, 0)).toBe("bossbar set polaris:event color purple");
        const colors = new Set(
            [0, 5_000, 10_000, 15_000, 20_000].map((now) => ambience.barColorLine(winter, now))
        );
        expect([...colors].sort()).toEqual([
            "bossbar set polaris:event color green",
            "bossbar set polaris:event color red"
        ]);
    });

    it("sends a bounded handful of rockets over the arena for the winner", () => {
        for (const dressing of DRESSINGS) {
            const done = playRun("glass-bridge", dressing, 0);
            const lines = ambience.winLines(done, "Player0", "en");
            const rockets = lines.filter((line) =>
                line.includes(" summon minecraft:firework_rocket ")
            );
            expect(rockets).toHaveLength(ambience.MOST_ROCKETS);
            expect(ambience.MOST_ROCKETS).toBeLessThanOrEqual(6);
            for (const line of rockets) {
                const [x, y, z] = line.split(" summon minecraft:firework_rocket ")[1]!.split(" ");
                expect(Number(y)).toBe(122);
                expect(Math.abs(Number(x) - 20)).toBeLessThanOrEqual(4);
                expect(Math.abs(Number(z) - 15)).toBeLessThanOrEqual(4);
                expect(line).toContain("LifeTime:30");
                if (dressing.era.components) {
                    expect(line).toContain(`components:{"minecraft:fireworks":{`);
                    expect(line).not.toContain("Count:1b");
                } else {
                    expect(line).toContain("Count:1b,tag:{Fireworks:{");
                    expect(line).not.toContain("components:");
                }
            }
            expect(lines.at(-1)).toMatch(/^tellraw @a /);
            expect(lines.at(-1)).toContain("Player0");
            expect(ambience.winLines(done, null, "en")).toEqual([]);
        }
    });

    it("puts the rockets over a stage's own boxes, never its scenery", () => {
        const done = {
            ...playRun("spleef", winter, 0),
            arena: null,
            stage: {
                goAt: 0,
                racers: [],
                boxes: [
                    { x1: 0, y1: 100, z1: 0, x2: 10, y2: 104, z2: 10, block: "minecraft:glass" },
                    {
                        x1: -50,
                        y1: 90,
                        z1: -50,
                        x2: 60,
                        y2: 140,
                        z2: 60,
                        block: "minecraft:oak_leaves",
                        scenery: true
                    }
                ]
            }
        } as never;
        expect(ambience.skyOver(done)).toEqual({ x: 5, y: 106, z: 5 });
    });

    it("reads a run saved before it as undressed", () => {
        const shape = stored.runSchema.shape.season;
        expect(shape.parse(undefined)).toBeNull();
        expect(
            shape.parse({ season: "winter", era: { lanterns: true, soulLanterns: false } })
        ).toEqual({ season: "winter", era: { lanterns: true, soulLanterns: false } });
    });
});
