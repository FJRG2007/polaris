/**
 * The glass bridge (`kinds/glass-bridge`): its map checked against its rules
 * over many runs, the rules it decides with no server at all, and a few ticks
 * of its loop (`glass-bridge-service`) against a server that only answers
 * where everybody is.
 */

import { describe, expect, it } from "vitest";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";
import * as glass from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/glass-bridge";
import * as pack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const SITE = { x: 300, z: -120 };
const Y = 100;
const SEEDS = 40;
const BASE = catalog.FINISH_BASE;

const bare = (id: string) => id.replace(/\[.*$/, "");
const inside = (box: stored.Box, f: stored.Box) =>
    f.x1 >= box.x1 &&
    f.x2 <= box.x2 &&
    f.y1 >= box.y1 &&
    f.y2 <= box.y2 &&
    f.z1 >= box.z1 &&
    f.z2 <= box.z2;

/** Standing in the middle of a box's top. */
const standing = (box: stored.Box) => ({
    x: (box.x1 + box.x2 + 1) / 2,
    y: box.y1 + 1,
    z: (box.z1 + box.z2 + 1) / 2
});

describe("the bridge", () => {
    for (const steps of [6, 12, 20]) {
        it(`is built only into its own box, with no bed or spawn block, for ${steps} rows`, () => {
            const box = glass.bridgeBox(SITE, Y, steps);
            expect(Math.ceil((box.x2 - box.x1 + 1) / 2)).toBeLessThanOrEqual(glass.reachOf(steps));
            const fills = glass.bridgeFills(box, steps);
            for (const fill of fills) {
                expect(inside(box, fill.box)).toBe(true);
                expect(glass.BRIDGE_BLOCKS).toContain(bare(fill.block));
                expect(fill.block).not.toMatch(/bed|respawn_anchor|spawner|beacon/);
            }
            // The start's south rim last: its corner is the proof the blocks stayed.
            const layout = glass.layoutOf(box, steps);
            expect(fills.at(-1)!.box).toEqual({ ...layout.start, z1: layout.start.z2 });
            // Every row's two panels, the same glass, with air between them.
            for (let row = 0; row < steps; row += 1) {
                const [north, south] = [
                    glass.panelOf(layout, row, 0),
                    glass.panelOf(layout, row, 1)
                ];
                expect(fills).toContainEqual({ box: north.box, block: glass.GLASS });
                expect(fills).toContainEqual({ box: south.box, block: glass.GLASS });
                expect(south.box.z1 - north.box.z2).toBe(2);
                if (row > 0)
                    expect(north.box.x1 - glass.panelOf(layout, row - 1, 0).box.x2).toBe(2);
            }
            // Nothing solid under the glass but the pool, far below.
            const under = fills.filter(
                (fill) =>
                    fill.box.y2 < layout.y &&
                    fill.box.y2 > layout.pool.y2 &&
                    fill.box.x2 >= layout.firstX &&
                    fill.box.x1 < layout.finish.x1
            );
            expect(under).toEqual([]);
            expect(layout.y - layout.pool.y2).toBeGreaterThan(5);
            // The pool catches a fall off any side of the bridge or a platform.
            expect(layout.pool.z1).toBeLessThan(layout.start.z1);
            expect(layout.pool.z2).toBeGreaterThan(layout.start.z2);
            expect(layout.pool.x1).toBeLessThan(layout.start.x1);
            expect(layout.pool.x2).toBeGreaterThan(layout.finish.x2);
        });
    }

    it("draws one panel that breaks in every row, the same again on a restart", () => {
        const layout = glass.layoutOf(glass.bridgeBox(SITE, Y, 20), 20);
        const lanes = new Set<number>();
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const breaking = glass.breakingPanels(layout, `run-${seed}`);
            expect(breaking).toHaveLength(20);
            for (const panel of breaking) {
                expect(panel.lane).not.toBe(glass.safeLane(`run-${seed}`, panel.row));
                lanes.add(panel.lane);
            }
            expect(glass.breakingPanels(layout, `run-${seed}`)).toEqual(breaking);
        }
        expect(lanes).toEqual(new Set([0, 1]));
    });

    it("takes down everything it placed", () => {
        const fills = glass.bridgeFills(glass.bridgeBox(SITE, Y, 12), 12);
        const taken = new Set(arena.withDecayed(glass.BRIDGE_BLOCKS));
        for (const fill of fills) expect(taken.has(bare(fill.block))).toBe(true);
        // Water freezing to ice under a cold sky is taken too.
        expect(taken.has("minecraft:ice")).toBe(true);
        // Lanterns before the pillars and beams that hold them.
        expect(glass.BRIDGE_BLOCKS.indexOf("minecraft:lantern")).toBeLessThan(
            glass.BRIDGE_BLOCKS.indexOf("minecraft:quartz_pillar")
        );
    });

    it("tells where somebody stands", () => {
        const layout = glass.layoutOf(glass.bridgeBox(SITE, Y, 6), 6);
        expect(glass.rowsReached(layout, standing(layout.start))).toBe(0);
        expect(glass.rowsReached(layout, standing(glass.panelOf(layout, 0, 1).box))).toBe(1);
        expect(glass.rowsReached(layout, standing(glass.panelOf(layout, 5, 0).box))).toBe(6);
        expect(glass.rowsReached(layout, standing(layout.finish))).toBe(6);
        expect(glass.onFinish(layout, standing(layout.finish))).toBe(true);
        // In the air between two rows: nowhere yet.
        const gap = {
            ...standing(glass.panelOf(layout, 0, 0).box),
            x: glass.panelOf(layout, 0, 0).box.x2 + 1.5
        };
        expect(glass.rowsReached(layout, gap)).toBeNull();
        expect(glass.fallen(layout, { y: layout.y - 1 })).toBe(true);
        expect(glass.fallen(layout, { y: layout.y + 1 })).toBe(false);
        expect(glass.inGallery(layout, glass.gallerySpot(layout, 3))).toBe(true);
        for (let index = 0; index < glass.MOST; index += 1) {
            const spot = glass.startSpot(layout, index);
            expect(glass.onStart(layout, { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 })).toBe(
                true
            );
            const done = glass.finishSpot(layout, index);
            expect(glass.onFinish(layout, { x: done.x + 0.5, y: done.y, z: done.z + 0.5 })).toBe(
                true
            );
        }
        // A jump in place on a platform is still on it.
        for (const platform of [layout.start, layout.finish]) {
            const jumping = { ...standing(platform), y: platform.y1 + 2.25 };
            expect(glass.onStart(layout, jumping)).toBe(platform === layout.start);
            expect(glass.onFinish(layout, jumping)).toBe(platform === layout.finish);
        }
    });

    it("breaks only the panel that breaks, under somebody standing on it", () => {
        const layout = glass.layoutOf(glass.bridgeBox(SITE, Y, 12), 12);
        for (let row = 0; row < 12; row += 1) {
            const safe = glass.panelOf(layout, row, glass.safeLane("run-1", row));
            const weak = glass.panelOf(layout, row, glass.safeLane("run-1", row) === 0 ? 1 : 0);
            expect(glass.breakingUnder(layout, "run-1", standing(safe.box))).toBeNull();
            expect(glass.breakingUnder(layout, "run-1", standing(weak.box))).toEqual(weak);
            // Feet on its west or north lip, the middle over the gap: it breaks.
            expect(
                glass.breakingUnder(layout, "run-1", {
                    ...standing(weak.box),
                    x: weak.box.x1 - 0.2
                })
            ).toEqual(weak);
            expect(
                glass.breakingUnder(layout, "run-1", {
                    ...standing(weak.box),
                    z: weak.box.z1 - 0.2
                })
            ).toEqual(weak);
            // Falling through it, not standing on it.
            expect(
                glass.breakingUnder(layout, "run-1", { ...standing(weak.box), y: layout.y - 3 })
            ).toBeNull();
        }
    });
});

describe("the rules", () => {
    const names = ["Ana", "Ben", "Cy", "Dee"];
    const state = (overrides: Partial<glass.BridgeState>) => ({
        ...glass.stateSchema.parse({}),
        ...overrides
    });

    it("ranks a finish over any progress, the quicker finish first", () => {
        const decided = state({
            reached: {
                Ben: { rows: 7, at: 50 },
                Cy: { rows: 7, at: 40 },
                Dee: { rows: 3, at: 10 }
            },
            finished: [
                { name: "Ana", at: 100, rows: 12, seconds: 61 },
                { name: "Dee", at: 120, rows: 12, seconds: 70 }
            ]
        });
        const scores = glass.scoresOf(decided, names, BASE);
        expect(scores.get("Ana")).toBe(BASE - 61);
        expect(scores.get("Dee")).toBe(BASE - 70);
        expect(scores.get("Ben")).toBe(7);
        expect(catalog.finishedIn("glass-bridge", scores.get("Ana")!)).toBe(61);
        expect(catalog.finishedIn("glass-bridge", 7)).toBeNull();
        expect(glass.winnerOf(decided, names, BASE)).toBe("Ana");
        // Ana kept off the podium: the next across.
        expect(glass.winnerOf(decided, names, BASE, new Set(["ana"]))).toBe("Dee");
        // Nobody across: the furthest, whoever got there first.
        const short = state({ reached: decided.reached });
        expect(glass.winnerOf(short, names, BASE)).toBe("Cy");
        expect(glass.tiebreakOf(short).Cy).toBeLessThan(glass.tiebreakOf(short).Ben!);
        // Nobody left the start: no winner.
        expect(glass.winnerOf(state({}), names, BASE)).toBeNull();
    });

    it("lets everybody still going walk at once, or one at a time in turns", () => {
        const order = glass.orderFor("run-1", names);
        expect([...order].sort()).toEqual([...names].sort());
        expect(glass.orderFor("run-1", [...names].reverse())).toEqual(order);
        const playing = state({
            order,
            turn: 1,
            out: [{ name: "Ben", at: 1, rows: 0, seconds: 0 }]
        });
        expect(glass.walkers(playing, "free", names)).toEqual(["Ana", "Cy", "Dee"]);
        const turn = order[1]!;
        expect(glass.walkers(playing, "turns", names)).toEqual(turn === "Ben" ? [] : [turn]);
        expect(glass.walkers(state({ order, turn: null }), "turns", names)).toEqual([]);
    });
});

describe("the data pack", () => {
    it("ships the glass check, run every tick behind its switch", () => {
        const files = pack.packFiles();
        for (const folder of ["functions", "function"]) {
            expect(
                JSON.parse(files.get(`data/minecraft/tags/${folder}/tick.json`)!).values
            ).toContain("polaris:glass/tick");
            for (const name of Object.keys(glass.FUNCTIONS))
                expect(files.get(`data/polaris/${folder}/glass/${name}.mcfunction`)).toBe(
                    `${glass.FUNCTIONS[name]!.join("\n")}\n`
                );
        }
        expect(glass.FUNCTIONS.tick).toEqual([
            "execute if score #on polaris_glass matches 1 run function polaris:glass/run"
        ]);
        // Only a walker breaks glass, over the whole panel and nowhere else.
        expect(glass.FUNCTIONS.run![0]).toContain(`@a[tag=${glass.WALKER_TAG},dx=2,dy=0,dz=2]`);
        // The stand stands in its corner block's middle: checked from the corner.
        expect(glass.FUNCTIONS.run![0]).toContain("at @s positioned ~-0.5 ~ ~-0.5 if entity");
        expect(glass.FUNCTIONS.shatter![0]).toBe(
            "fill ~ ~-1 ~ ~2 ~-1 ~2 minecraft:air replace minecraft:glass"
        );
        expect(glass.FUNCTIONS.shatter!.at(-1)).toBe("kill @s");
    });

    it("puts the walkers on a team nobody is pushed off by, and takes it away at the end", () => {
        const lines = glass.noPushLines(["Ana", "Bo"]);
        expect(lines).toContain(`team modify ${glass.NO_PUSH_TEAM} collisionRule never`);
        expect(lines).toContain(
            `execute if entity @a[name=Ana,team=] run team join ${glass.NO_PUSH_TEAM} Ana`
        );
        expect(glass.stopLines(glass.bridgeBox(SITE, Y, 6))).toContain(
            `team remove ${glass.NO_PUSH_TEAM}`
        );
    });

    it("is armed with a marker on every panel that breaks, and switched off at the end", () => {
        const box = glass.bridgeBox(SITE, Y, 20);
        const layout = glass.layoutOf(box, 20);
        const lines = glass.armLines(box, layout, "run-1");
        const markers = lines.filter((line) => line.includes("summon minecraft:armor_stand"));
        expect(markers).toHaveLength(20);
        for (const panel of glass.breakingPanels(layout, "run-1"))
            expect(
                markers.some((line) =>
                    line.includes(` ${panel.box.x1} ${layout.y + 1} ${panel.box.z1} `)
                )
            ).toBe(true);
        expect(lines.at(-1)).toBe("scoreboard players set #on polaris_glass 1");
        const stop = glass.stopLines(box);
        expect(stop[0]).toBe("scoreboard players set #on polaris_glass 0");
        expect(stop.join("\n")).toContain(`tag=${glass.FAKE_TAG},x=${box.x1}`);
        for (const line of [...lines, ...stop])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});

// ------------------------------------------------------------------ the loop

const where = (name: string, at: { x: number; y: number; z: number }) =>
    `${name} has the following entity data: [${at.x}d, ${at.y}d, ${at.z}d]`;

function entrant(name: string, side: number) {
    return {
        name,
        uuid: null,
        dimension: "minecraft:overworld",
        x: 0,
        y: 64,
        z: 0,
        yaw: 0,
        pitch: 0,
        gamemode: "survival" as const,
        side
    };
}

function runOf(mode: "free" | "turns", players: readonly string[], steps = 6) {
    const preset = catalog.newPreset("glass-bridge", "bridge");
    const box = glass.bridgeBox(SITE, Y, steps);
    return stored.runSchema.parse({
        id: "run-1",
        trigger: "manual",
        startedBy: null,
        preset: { ...preset, options: { ...preset.options, mode, steps, turnSeconds: 10 } },
        phase: "running",
        createdAt: 0,
        startsAt: 0,
        endsAt: 1,
        readyAt: 0,
        joined: [...players],
        entrants: players.map((name, side) => entrant(name, side)),
        arena: { box, blocks: [...glass.BRIDGE_BLOCKS] }
    });
}

const order = (run: stored.EventRun) =>
    glass.orderFor(
        run.id,
        run.entrants.map((one) => one.name)
    );

/** A context whose server answers only where everybody is. */
function contextFor(run: stored.EventRun) {
    let positions = new Map<string, { x: number; y: number; z: number }>();
    const sent: string[] = [];
    const ctx = {
        server: {
            say: async (lines: string[]) =>
                lines[0] === commands.IN_OVERWORLD
                    ? [...positions].map(([name, at]) => where(name, at)).join("")
                    : "",
            sayAll: async (lines: string[]) => void sent.push(...lines)
        },
        language: "en",
        home: "en",
        now: 0,
        run,
        persist: async () => {},
        tickSeconds: 0.5
    };
    return {
        ctx: ctx as never as Parameters<NonNullable<ReturnType<typeof gameOf>>["tick"]>[0],
        place: (next: Record<string, { x: number; y: number; z: number }>) => {
            positions = new Map(Object.entries(next));
        },
        at: (now: number) => {
            ctx.now = now;
        },
        get run() {
            return (ctx as { run: stored.EventRun }).run;
        }
    };
}

describe("a glass bridge played", () => {
    const game = gameOf("glass-bridge")!;

    it("is played in an arena of its own, its glass broken by the events data pack", () => {
        const preset = catalog.newPreset("glass-bridge", "bridge");
        expect(game).not.toBeNull();
        expect(game.hits).toBe(true);
        expect(catalog.playsInArena(preset)).toBe(true);
        expect(catalog.heldWhere(preset)).toBe("sky");
        expect(catalog.needsPvp(preset)).toBe(false);
        expect(catalog.presetSchema.safeParse(preset).success).toBe(true);
        expect(
            catalog.presetSchema.safeParse({ ...preset, options: { ...preset.options, steps: 30 } })
                .success
        ).toBe(false);
    });

    it("puts out whoever falls, counts whoever crosses, and ends once all are done", async () => {
        const run = runOf("free", ["Ana", "Ben"]);
        const layout = glass.layoutOf(run.arena!.box, 6);
        const world = contextFor(run);
        const lines: string[] = [];
        // Ana on the third row's panel that breaks: the look breaks it too.
        const weak = glass.breakingPanels(layout, run.id)[2]!;
        world.place({ Ana: standing(weak.box), Ben: standing(layout.start) });
        world.at(5_000);
        expect(await game.tick(world.ctx, lines)).toBeNull();
        for (const line of glass.shatterLines(weak)) expect(lines).toContain(line);
        expect(glass.stateOf(world.run.game)!.reached.Ana).toEqual({ rows: 3, at: 5_000 });
        // Ana under the glass: out, sent to the gallery. Ben across.
        lines.length = 0;
        world.place({
            Ana: { ...standing(weak.box), y: layout.y - 4 },
            Ben: standing(layout.finish)
        });
        world.at(30_000);
        expect(await game.tick(world.ctx, lines)).toBe("Everybody has crossed or fallen");
        const state = glass.stateOf(world.run.game)!;
        expect(state.out.map((one) => one.name)).toEqual(["Ana"]);
        expect(state.finished).toEqual([{ name: "Ben", at: 30_000, rows: 6, seconds: 30 }]);
        expect(lines).toContain(arena.moveTo("Ana", glass.gallerySpot(layout, 0)));
        expect(world.run.points).toEqual({ Ana: 3, Ben: BASE - 30 });
        expect(game.results(world.run)).toEqual(
            new Map([
                ["Ana", 3],
                ["Ben", BASE - 30]
            ])
        );
        expect(game.resultLines(world.run, "en", new Set()).join("")).toContain("Ben");
    });

    it("in turns, holds everybody but the walker on the start, and puts out a walker who stands still", async () => {
        const run = runOf("turns", ["Ana", "Ben", "Cy"]);
        const layout = glass.layoutOf(run.arena!.box, 6);
        const world = contextFor(run);
        const order = glass.orderFor(run.id, ["Ana", "Ben", "Cy"]);
        const [first, second, third] = order as [string, string, string];
        const lines: string[] = [];
        // Somebody waiting steps onto the bridge: back to the start, no glass for them.
        const safe = glass.panelOf(layout, 0, glass.safeLane(run.id, 0));
        world.place({
            [first]: standing(safe.box),
            [second]: standing(glass.breakingPanels(layout, run.id)[0]!.box),
            [third]: standing(layout.start)
        });
        world.at(2_000);
        await game.tick(world.ctx, lines);
        const secondSide = run.entrants.find((one) => one.name === second)!.side;
        expect(lines).toContain(arena.moveTo(second, glass.startSpot(layout, secondSide)));
        expect(lines).toContain(glass.walkerLine(first, true));
        expect(lines).toContain(glass.walkerLine(second, false));
        expect(lines.filter((line) => line.includes("replace minecraft:glass"))).toEqual([]);
        // The walker stands still past the time: out, and the next one is on.
        lines.length = 0;
        world.place({
            [first]: standing(safe.box),
            [second]: standing(layout.start),
            [third]: standing(layout.start)
        });
        world.at(13_000);
        await game.tick(world.ctx, lines);
        const state = glass.stateOf(world.run.game)!;
        expect(state.out.map((one) => one.name)).toEqual([first]);
        expect(state.turn).toBe(1);
        expect(lines.join("\n")).toContain(`title ${second} title`);
        expect(glass.walkers(state, "turns", ["Ana", "Ben", "Cy"])).toEqual([second]);
    });

    it("in turns, ranks whoever crossed first above a quicker later walker", async () => {
        const run = runOf("turns", ["Ana", "Ben"]);
        const layout = glass.layoutOf(run.arena!.box, 6);
        const world = contextFor(run);
        const [first, second] = glass.orderFor(run.id, ["Ana", "Ben"]) as [string, string];
        const lines: string[] = [];
        world.place({ [first]: standing(layout.finish), [second]: standing(layout.start) });
        world.at(40_000);
        await game.tick(world.ctx, lines);
        world.place({ [first]: standing(layout.finish), [second]: standing(layout.finish) });
        world.at(45_000);
        await game.tick(world.ctx, lines);
        const state = glass.stateOf(world.run.game)!;
        expect(state.finished.map((one) => [one.name, one.seconds])).toEqual([
            [first, 40],
            [second, 45]
        ]);
        expect(game.resultLines(world.run, "en", new Set()).join("")).toContain(first);
        // Waiting on the start, a jump in place is not pulled back.
        const waiting = runOf("turns", ["Ana", "Ben"]);
        const waitWorld = contextFor(waiting);
        const waiter = glass.orderFor(waiting.id, ["Ana", "Ben"])[1]!;
        const side = waiting.entrants.find((one) => one.name === waiter)!.side;
        const spot = glass.startSpot(layout, side);
        const jumpLines: string[] = [];
        waitWorld.place({
            [order(waiting)[0]!]: standing(layout.start),
            [waiter]: { x: spot.x + 0.5, y: spot.y + 1.2, z: spot.z + 0.5 }
        });
        waitWorld.at(1_000);
        await game.tick(waitWorld.ctx, jumpLines);
        expect(jumpLines).not.toContain(arena.moveTo(waiter, spot));
    });

    it("in turns, lasts long enough for every walker's whole turn", () => {
        const preset = runOf("turns", ["Ana"], 12).preset;
        expect(catalog.playSeconds(preset, 1)).toBe(preset.minutes * 60);
        expect(catalog.playSeconds(preset, 24)).toBe(24 * 12 * 10);
        expect(catalog.playSeconds(runOf("free", ["Ana"], 12).preset, 24)).toBe(
            preset.minutes * 60
        );
    });

    it("takes its markers and switch away at the end, whatever the box", () => {
        const run = runOf("free", ["Ana"]);
        expect(game.endLines!(run)).toEqual(glass.stopLines(run.arena!.box));
        expect(game.closeLines!(run.arena!.box)).toEqual(glass.stopLines(run.arena!.box));
    });
});

describe("what a glass bridge shows", () => {
    it("keeps its race scores off the sidebar", () => {
        expect(commands.hasScoreboard(catalog.newPreset("glass-bridge", "bridge"))).toBe(false);
    });
});
