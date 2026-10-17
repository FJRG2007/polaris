/**
 * Pillars, pure and played: the ring (no jump reaches the next pillar, all of
 * it inside the box), the item pools and their weights, the loot tables and
 * the events pack's drop, the fallback drop given from the loop, the rising
 * void, the twists, and a tick against a fake server - who is put out and
 * why, their kit taken back, the drops from the pack or the loop, the end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as stored from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as pi from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/pillars";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as sw from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars";
import { seeded } from "@polaris-app/game-servers/src/lib/minecraft/events/trivia-bank";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";
import * as pack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/pillars-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

/** Whether the events pack is on, for the tick: switched per test. */
let packOn = false;
vi.mock(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hits-service",
    async (original) => ({
        ...(await original<object>()),
        ensure: async () => packOn,
        attackers: async () => new Map()
    })
);

const at = { x: 100, y: 120, z: -40 };

describe("the pillars' ring", () => {
    for (const players of [2, 3, 5, 8, 12, 16]) {
        it(`for ${players}: one pillar each, none a jump from another, all in the box`, () => {
            const layout = pi.layoutFor(players, true);
            expect(layout.pillars).toHaveLength(players);
            const box = pi.arenaBox(layout, at);
            const play = pi.playArea(layout, at);
            for (const [index, one] of layout.pillars.entries()) {
                for (const other of layout.pillars.slice(index + 1))
                    expect(Math.hypot(one.x - other.x, one.z - other.z)).toBeGreaterThanOrEqual(5);
                // Off the middle platform too.
                expect(Math.max(Math.abs(one.x), Math.abs(one.z))).toBeGreaterThanOrEqual(5);
                expect(sw.inPlay(play, pi.startSpot(layout, at, index))).toBe(true);
            }
            for (const fill of pi.arenaFills(layout, at)) {
                expect(fill.box.x1).toBeGreaterThanOrEqual(box.x1);
                expect(fill.box.x2).toBeLessThanOrEqual(box.x2);
                expect(fill.box.y1).toBeGreaterThanOrEqual(box.y1);
                expect(fill.box.y2).toBeLessThanOrEqual(box.y2);
                expect(fill.box.z1).toBeGreaterThanOrEqual(box.z1);
                expect(fill.box.z2).toBeLessThanOrEqual(box.z2);
                expect(pi.ARENA_BLOCKS).toContain(fill.block);
                const size =
                    (fill.box.x2 - fill.box.x1 + 1) *
                    (fill.box.y2 - fill.box.y1 + 1) *
                    (fill.box.z2 - fill.box.z1 + 1);
                expect(size).toBeLessThanOrEqual(32_768);
            }
            expect(pi.reachOf(layout)).toBeGreaterThanOrEqual(layout.ring);
        });
    }

    it("has a barrier floor under everything, a bedrock pillar each, and the middle only when asked", () => {
        const fills = pi.arenaFills(pi.layoutFor(4, true), at);
        const box = pi.arenaBox(pi.layoutFor(4, true), at);
        expect(fills[0]).toEqual({ box: { ...box, y2: box.y1 }, block: "minecraft:barrier" });
        expect(fills.filter((one) => one.block === "minecraft:bedrock")).toHaveLength(4);
        for (const one of fills.filter((fill) => fill.block === "minecraft:bedrock")) {
            expect(one.box.y2).toBe(at.y);
            expect(one.box.y2 - one.box.y1 + 1).toBe(pi.PILLAR_DEPTH);
        }
        expect(fills.some((one) => one.block === "minecraft:smooth_stone")).toBe(true);
        expect(
            pi.arenaFills(pi.layoutFor(4, false), at).some((one) => one.block === "minecraft:smooth_stone")
        ).toBe(false);
    });

    it("is never built so low that its box reaches the ground", () => {
        const layout = pi.layoutFor(8, true);
        const top = pi.topOver(64, 40);
        expect(pi.arenaBox(layout, { ...at, y: top }).y1).toBeGreaterThan(64);
    });
});

describe("the pillars' items", () => {
    it("draws only blocks in the blocks pool, and the wild stuff only in chaos", () => {
        const ids = (pool: pi.Pool) => new Set(pi.poolOf(pool).map((one) => one.drop.id));
        const blocks = ids("blocks");
        expect([...blocks].every((id) => pi.ARENA_BLOCKS.includes(id) || id === "minecraft:ladder")).toBe(
            true
        );
        for (const wild of ["minecraft:tnt", "minecraft:flint_and_steel"]) {
            expect(ids("chaos").has(wild)).toBe(true);
            expect(ids("balanced").has(wild)).toBe(false);
        }
        expect(ids("balanced").has("minecraft:ender_pearl")).toBe(true);
        expect(ids("balanced").has("minecraft:splash_potion")).toBe(true);
    });

    it("draws by weight: over many draws each item comes up about as often as its share", () => {
        for (const pool of pi.POOLS) {
            const entries = pi.poolOf(pool);
            const total = entries.reduce((sum, one) => sum + one.weight, 0);
            const random = seeded(`weights-${pool}`);
            const counts = new Map<pi.Drop, number>();
            const draws = 40_000;
            for (let index = 0; index < draws; index += 1) {
                const drop = pi.draw(pool, random);
                counts.set(drop, (counts.get(drop) ?? 0) + 1);
            }
            for (const { drop, weight } of entries) {
                const share = (counts.get(drop) ?? 0) / draws;
                expect(Math.abs(share - weight / total)).toBeLessThan(0.012);
            }
        }
    });

    it("hands blocks out more than anything else, so a bridge is always within reach", () => {
        const share = (pool: pi.Pool) => {
            const entries = pi.poolOf(pool);
            const total = entries.reduce((sum, one) => sum + one.weight, 0);
            return (
                entries
                    .filter((one) => pi.ARENA_BLOCKS.includes(one.drop.id) || one.drop.id === "minecraft:ladder")
                    .reduce((sum, one) => sum + one.weight, 0) / total
            );
        };
        expect(share("blocks")).toBe(1);
        expect(share("balanced")).toBeGreaterThan(0.4);
        expect(share("chaos")).toBeGreaterThan(0.25);
    });

    it("writes each loot table the way its era marks an item", () => {
        const modern = JSON.stringify(pi.lootTable("balanced", "components"));
        const old = JSON.stringify(pi.lootTable("balanced", "tag"));
        expect(modern).toContain("minecraft:set_custom_data");
        expect(modern).toContain('"function":"minecraft:set_potion","id":"minecraft:swiftness"');
        expect(modern).not.toContain("set_nbt");
        expect(old).toContain("minecraft:set_nbt");
        expect(old).toContain('Potion:\\"minecraft:swiftness\\"');
        expect(old).not.toContain("set_custom_data");
        // One roll, every entry marked.
        const table = pi.lootTable("chaos", "components") as {
            pools: { rolls: number; entries: { functions: { function: string }[] }[] }[];
        };
        expect(table.pools).toHaveLength(1);
        expect(table.pools[0]!.rolls).toBe(1);
        for (const entry of table.pools[0]!.entries)
            expect(entry.functions.some((one) => one.function === "minecraft:set_custom_data")).toBe(true);
    });

    it("takes back every item it can hand out, and leaves nothing unmarked behind", () => {
        for (const drop of pi.DROPS) expect(pi.KIT_IDS).toContain(drop.id);
        // Nothing turns into an unmarked item once used: no buckets, and no
        // potion that leaves its bottle.
        for (const id of ["minecraft:water_bucket", "minecraft:lava_bucket", "minecraft:potion"])
            expect(pi.KIT_IDS).not.toContain(id);
        // A potion is cleared by its marker whatever it holds.
        expect(arena.clearMarked("Ana", "minecraft:splash_potion", "components")).toBe(
            "clear Ana minecraft:splash_potion[minecraft:custom_data={polaris_event:1b}]"
        );
    });
});

describe("the pillars' drops", () => {
    it("are in the events pack: each era's tables where its releases read them, and a bounded drop", () => {
        const files = pack.packFiles();
        const tables = (folder: string) =>
            [...files.keys()]
                .filter((path) => path.startsWith(`data/polaris/${folder}/pillars/`))
                .map((path) => path.slice(`data/polaris/${folder}/pillars/`.length))
                .sort();
        // Up to 1.20.6 the plural folder, read by both eras; from 1.21 the
        // singular one, read only by releases that write components.
        expect(tables("loot_tables")).toEqual(
            Object.keys(pi.LOOT_TABLES)
                .map((name) => `${name}.json`)
                .sort()
        );
        expect(tables("loot_table")).toEqual(
            pi.POOLS.map((pool) => `${pool}_components.json`).sort()
        );
        for (const [path, content] of files) {
            if (!/\/loot_tables?\/pillars\//.test(path)) continue;
            const name = path.split("/").at(-1)!.replace(/\.json$/, "");
            expect(JSON.parse(content)).toEqual(pi.LOOT_TABLES[name]);
        }
        for (const folder of ["functions", "function"]) {
            const read = (name: string) =>
                files.get(`data/polaris/${folder}/pillars/${name}.mcfunction`)!.trimEnd().split("\n");
            expect(files.get(`data/minecraft/tags/${folder}/tick.json`)).toContain(
                "polaris:pillars/tick"
            );
            // Each era's rolls in a function of its own: from 1.20.5 a function
            // naming a table that did not load is refused whole, so the era a
            // release cannot load never takes the drop down with it.
            expect(read("drop")).toContain(
                `execute if score #era ${pi.OBJECTIVE} matches 1 run function polaris:pillars/drop_components`
            );
            expect(read("drop")).toContain(
                `execute if score #era ${pi.OBJECTIVE} matches 0 run function polaris:pillars/drop_tag`
            );
            expect(read("drop").some((line) => line.includes("loot give"))).toBe(false);
            // Each player still in rolls their own: one command for all of them.
            for (const era of ["components", "tag"] as const)
                expect(read(`drop_${era}`)).toEqual(
                    pi.POOLS.map(
                        (pool, index) =>
                            `execute if score #pool ${pi.OBJECTIVE} matches ${index} as @a[tag=${pi.IN_TAG},tag=!${pi.OUT_TAG}] run loot give @s loot polaris:pillars/${pool}_${era}`
                    )
                );
        }
        // Every function one of them names is in the pack, and no line starts
        // with a slash, which a function refuses.
        for (const lines of Object.values(pi.FUNCTIONS))
            for (const line of lines) {
                expect(line.startsWith("/")).toBe(false);
                for (const [, name] of line.matchAll(/function polaris:pillars\/(\w+)/g))
                    expect(Object.keys(pi.FUNCTIONS)).toContain(name);
            }
    });

    it("writes each loot table in the vanilla format of its era, and nothing else", () => {
        interface Entry {
            type: string;
            name: string;
            weight: number;
            functions: { function: string; [key: string]: unknown }[];
        }
        const allowed = {
            // 1.20.5 on: `set_nbt` became `set_custom_data`.
            components: ["minecraft:set_count", "minecraft:set_custom_data", "minecraft:set_potion"],
            // 1.17 to 1.20.4: `set_potion` is only 1.18 on, so the potion goes in the data.
            tag: ["minecraft:set_count", "minecraft:set_nbt"]
        };
        const potions = [
            "minecraft:swiftness",
            "minecraft:leaping",
            "minecraft:healing",
            "minecraft:slow_falling",
            "minecraft:harming"
        ];
        const single =
            /_(sword|axe|pickaxe|helmet|chestplate)$|^minecraft:(bow|fishing_rod|shield|shears|flint_and_steel|splash_potion)$/;
        for (const pool of pi.POOLS)
            for (const era of ["components", "tag"] as const) {
                const table = pi.lootTable(pool, era) as { pools: { rolls: number; entries: Entry[] }[] };
                expect(Object.keys(table)).toEqual(["pools"]);
                expect(table.pools).toHaveLength(1);
                expect(Object.keys(table.pools[0]!).sort()).toEqual(["entries", "rolls"]);
                expect(table.pools[0]!.rolls).toBe(1);
                const entries = table.pools[0]!.entries;
                expect(entries.map((one) => [one.name, one.weight])).toEqual(
                    pi.poolOf(pool).map(({ drop, weight }) => [drop.id, weight])
                );
                for (const [index, entry] of entries.entries()) {
                    const drop = pi.poolOf(pool)[index]!.drop;
                    expect(Object.keys(entry).sort()).toEqual(["functions", "name", "type", "weight"]);
                    expect(entry.type).toBe("minecraft:item");
                    expect(entry.name).toMatch(/^minecraft:[a-z_]+$/);
                    expect(Number.isInteger(entry.weight) && entry.weight > 0).toBe(true);
                    for (const one of entry.functions) expect(allowed[era]).toContain(one.function);
                    // Never more than a stack, and one of anything that does not stack.
                    expect(drop.count).toBeLessThanOrEqual(single.test(drop.id) ? 1 : 16);
                    const count = entry.functions.find((one) => one.function === "minecraft:set_count");
                    if (drop.count > 1) expect(count).toEqual({ function: "minecraft:set_count", count: drop.count });
                    else expect(count).toBeUndefined();
                    if (era === "components") {
                        expect(entry.functions).toContainEqual({
                            function: "minecraft:set_custom_data",
                            tag: "{polaris_event:1b}"
                        });
                        const potion = entry.functions.find((one) => one.function === "minecraft:set_potion");
                        if (drop.potion) {
                            expect(potions).toContain(drop.potion);
                            expect(potion).toEqual({ function: "minecraft:set_potion", id: drop.potion });
                        } else expect(potion).toBeUndefined();
                    } else
                        expect(entry.functions).toContainEqual({
                            function: "minecraft:set_nbt",
                            tag: drop.potion
                                ? `{polaris_event:1b,Potion:"${drop.potion}"}`
                                : "{polaris_event:1b}"
                        });
                }
            }
        // The fallback's item arguments, as `give` reads them in each era.
        const leaping = pi.DROPS.find((one) => one.potion === "minecraft:leaping")!;
        expect(pi.itemOf(leaping, "components")).toBe(
            'minecraft:splash_potion[minecraft:custom_data={polaris_event:1b},minecraft:potion_contents={potion:"minecraft:leaping"}]'
        );
        expect(pi.itemOf(pi.DROPS[0]!, "tag")).toBe("minecraft:oak_planks{polaris_event:1b}");
    });
    it("is switched on with its interval, pool and era, the first drop at once, and off safely", () => {
        const on = pi.armLines(7, "chaos", "tag");
        expect(on).toContain(`scoreboard players set #every ${pi.OBJECTIVE} 140`);
        expect(on).toContain(`scoreboard players set #pool ${pi.OBJECTIVE} 2`);
        expect(on).toContain(`scoreboard players set #era ${pi.OBJECTIVE} 0`);
        expect(on).toContain(`scoreboard players set #left ${pi.OBJECTIVE} 1`);
        expect(on.at(-1)).toBe(`scoreboard players set #on ${pi.OBJECTIVE} 1`);
        expect(pi.STOP_LINES[0]).toBe(`scoreboard players set #on ${pi.OBJECTIVE} 0`);
        expect(pi.intervalTicks(1)).toBe(20);
    });

    it("falls back to one marked give per player, in one batch, the same draw after a restart", () => {
        const lines = pi.dropLines("run-1", 3, ["Ana", "Ben", "Cy"], "balanced", "components");
        expect(lines).toHaveLength(3);
        expect(lines).toEqual(pi.dropLines("run-1", 3, ["Ana", "Ben", "Cy"], "balanced", "components"));
        for (const line of lines) {
            expect(line).toMatch(/^give (Ana|Ben|Cy) minecraft:[a-z_]+\[minecraft:custom_data=\{polaris_event:1b\}/);
            expect(commandBytes(line)).toBeLessThan(COMMAND_BYTES_MAX);
        }
        const old = pi.dropLines("run-1", 3, ["Ana"], "blocks", "tag")[0]!;
        expect(old).toMatch(/^give Ana minecraft:[a-z_]+\{polaris_event:1b\} \d+$/);
        const potion = pi.itemOf(pi.DROPS.find((one) => one.potion === "minecraft:leaping")!, "tag");
        expect(potion).toBe('minecraft:splash_potion{polaris_event:1b,Potion:"minecraft:leaping"}');
    });

    it("counts drops and twists due from the start", () => {
        expect(pi.dropsDue(1_000, 7, 500)).toBe(0);
        expect(pi.dropsDue(1_000, 7, 1_000)).toBe(1);
        expect(pi.dropsDue(1_000, 7, 8_000)).toBe(2);
        expect(pi.twistsDue(0, pi.TWIST_MS * 2 + 1)).toBe(2);
        expect(pi.TWISTS).toContain(pi.twistOf("run-1", 0));
        expect(pi.twistLines("bonus")).toEqual([]);
        expect(pi.twistLines("speed")[0]).toContain("minecraft:speed");
    });
});

describe("the rising void", () => {
    const play = pi.playArea(pi.layoutFor(4, true), at);

    it("stays at the floor until its minutes, then rises a block every few seconds, up to the top", () => {
        expect(pi.voidLevel(play, 0, 4, 4 * 60_000)).toBe(play.y1);
        expect(pi.voidLevel(play, 0, 4, 4 * 60_000 + pi.RISE_MS * 5)).toBe(play.y1 + 5);
        expect(pi.voidLevel(play, 0, 4, 99 * 60_000)).toBe(play.y2);
        expect(pi.voidLevel(play, 0, 0, 99 * 60_000)).toBe(play.y1);
        expect(pi.voidLevel(play, null, 4, 99 * 60_000)).toBe(play.y1);
    });

    it("is what the quick look puts out under, besides past the edges", () => {
        const layout = pi.layoutFor(4, true);
        const box = pi.arenaBox(layout, at);
        const lines = pi.quickLines(layout, at, box, play.y1 + 10, ["Ana", "Ben"]);
        // Nobody but the players carries the tag: never moved, never handed items.
        expect(lines[0]).toBe(`tag @a[tag=${pi.IN_TAG},name=!Ana,name=!Ben] remove ${pi.IN_TAG}`);
        expect(lines[1]).toContain(`dy=${play.y1 + 10 - 1 - (box.y1 - 128)}`);
        expect(lines.some((line) => line.includes(`tp @a[tag=${pi.IN_TAG},tag=!${pi.OUT_TAG},tag=${pi.GONE_TAG}]`))).toBe(true);
        // Only marked items are ever taken.
        expect(lines.some((line) => line.startsWith("clear "))).toBe(false);
    });
});

// ------------------------------------------------------------------ played

const where = (name: string, spot: { x: number; y: number; z: number }) =>
    `${name} has the following entity data: [${spot.x}d, ${spot.y}d, ${spot.z}d]`;

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

const PLACE = { x: 0, y: 64, z: 0 };

function runOf(players: readonly string[], options: Partial<catalog.EventOptions<"pillars">> = {}) {
    const preset = catalog.newPreset("pillars", "pillars");
    const run = stored.runSchema.parse({
        id: "run-1",
        trigger: "manual",
        startedBy: null,
        preset: { ...preset, options: { ...preset.options, ...options } },
        phase: "running",
        createdAt: 0,
        startsAt: 0,
        endsAt: 600_000,
        readyAt: 0,
        joined: [...players],
        entrants: players.map((name, side) => entrant(name, side)),
        place: PLACE,
        marker: "components"
    });
    const game = gameOf("pillars")!;
    return stored.runSchema.parse({
        ...run,
        arena: { box: game.box(run, PLACE), blocks: game.blocks(run, game.box(run, PLACE)) }
    });
}

function contextFor(run: stored.EventRun) {
    let positions = new Map<string, { x: number; y: number; z: number }>();
    let died = new Map<string, number>();
    const ctx = {
        server: {
            say: async (lines: string[]) =>
                lines[0] === commands.IN_OVERWORLD
                    ? [...positions].map(([name, spot]) => where(name, spot)).join("")
                    : lines[0]!.includes("pe_died")
                      ? [...died].map(([name, count]) => `${name} has ${count} [pe_died]`).join("\n")
                      : "",
            sayAll: async () => {}
        },
        language: "en",
        home: "en",
        now: 0,
        run,
        persist: async () => {},
        tickSeconds: 2
    };
    return {
        ctx: ctx as never as Parameters<NonNullable<ReturnType<typeof gameOf>>["tick"]>[0],
        place: (next: Record<string, { x: number; y: number; z: number }>) => {
            positions = new Map(Object.entries(next));
        },
        die: (name: string) => died.set(name, 1),
        at: (now: number) => {
            ctx.now = now;
        },
        get run() {
            return (ctx as { run: stored.EventRun }).run;
        }
    };
}

describe("a pillars game played", () => {
    const game = gameOf("pillars")!;
    const layout = pi.layoutFor(3, true);
    const top = pi.topOver(PLACE.y, 40);
    const spot = (index: number) => pi.startSpot(layout, { ...PLACE, y: top }, index);

    beforeEach(() => {
        packOn = false;
    });

    it("is an arena kind like SkyWars: stashed first, PvP, last one standing, the pack on", () => {
        const preset = catalog.newPreset("pillars", "pillars");
        expect(game.hits).toBe(true);
        expect(catalog.playsInArena(preset)).toBe(true);
        expect(catalog.stashesFirst(preset)).toBe(true);
        expect(catalog.lastStanding(preset)).toBe(true);
        expect(catalog.needsPvp(preset)).toBe(true);
        expect(catalog.presetSchema.safeParse(preset).success).toBe(true);
        expect(preset.options).toMatchObject({ pool: "balanced", interval: 7, voidAfter: 4, middle: true, twists: true });
        expect(
            catalog.presetSchema.safeParse({ ...preset, options: { ...preset.options, interval: 1 } }).success
        ).toBe(false);
        expect(game.kit(runOf(["Ana"]))).toEqual([...pi.KIT_IDS]);
    });

    it("switches the pack's drops on at Go where the pack is on, and not where it is not", async () => {
        const run = runOf(["Ana", "Ben"], { pool: "blocks", interval: 5 });
        packOn = true;
        const on = await game.goLines(contextFor(run).ctx, { marker: "components", itemCommand: true });
        expect(on).toContain("gamemode survival Ana");
        expect(on).toContain(`tag Ana add ${pi.IN_TAG}`);
        expect(on).toEqual(expect.arrayContaining(pi.armLines(5, "blocks", "components")));
        packOn = false;
        const off = await game.goLines(contextFor(run).ctx, { marker: "components", itemCommand: true });
        expect(off.some((line) => line.includes(pi.OBJECTIVE))).toBe(false);
    });

    it("gives the drops from the loop when the pack is off - each due one once - and none from it when on", async () => {
        const run = runOf(["Ana", "Ben", "Cy"], { twists: false });
        const world = contextFor(run);
        world.place({ Ana: spot(0), Ben: spot(1), Cy: spot(2) });
        world.at(15_000);
        const lines: string[] = [];
        expect(await game.tick(world.ctx, lines)).toBeNull();
        // Due at 0, 7 and 14 seconds: three each.
        expect(lines.filter((line) => line.startsWith("give "))).toHaveLength(9);
        expect(pi.stateOf(world.run.game).drops).toBe(3);
        const again: string[] = [];
        await game.tick(world.ctx, again);
        expect(again.filter((line) => line.startsWith("give "))).toHaveLength(0);

        packOn = true;
        const packed = contextFor(runOf(["Ana", "Ben"], { twists: false }));
        packed.place({ Ana: spot(0), Ben: spot(1) });
        packed.at(15_000);
        const fromPack: string[] = [];
        await game.tick(packed.ctx, fromPack);
        expect(fromPack.filter((line) => line.startsWith("give "))).toHaveLength(0);
    });

    it("puts out whoever died or fell, takes their kit back, and ends with one left", async () => {
        const run = runOf(["Ana", "Ben", "Cy"], { twists: false });
        const world = contextFor(run);
        const play = pi.playArea(layout, { ...PLACE, y: top });
        world.place({ Ana: spot(0), Ben: { ...spot(1), y: play.y1 - 3 }, Cy: spot(2) });
        world.die("Cy");
        world.at(1_000);
        const lines: string[] = [];
        expect(await game.tick(world.ctx, lines)).toBe(said.LAST_ONE);
        const state = pi.stateOf(world.run.game);
        expect(state.out.map((one) => [one.name, one.why])).toEqual([
            ["Ben", "fell"],
            ["Cy", "died"]
        ]);
        expect(lines).toContain(arena.clearMarked("Ben", "minecraft:tnt", "components"));
        expect(lines.filter((line) => line.startsWith("clear ")).every((line) => line.includes("polaris_event:1b"))).toBe(true);
        expect(lines).toContain(`tag Ben add ${pi.OUT_TAG}`);
        expect(game.results(world.run)).toEqual(new Map([["Ana", 3], ["Ben", 1], ["Cy", 1]]));
        expect(game.resultLines(world.run, "en", new Set()).join("")).toContain("Ana");
        // A winner kept off the podium is never cheered.
        expect(game.resultLines(world.run, "en", new Set(["ana"]))).toEqual([]);
    });

    it("puts out whoever the rising void catches, and says once that it rises", async () => {
        const run = runOf(["Ana", "Ben", "Cy"], { twists: false, voidAfter: 1 });
        const world = contextFor(run);
        const play = pi.playArea(layout, { ...PLACE, y: top });
        world.place({ Ana: spot(0), Ben: { ...spot(1), y: play.y1 + 3 }, Cy: spot(2) });
        world.at(60_000 + pi.RISE_MS * 10);
        const lines: string[] = [];
        expect(await game.tick(world.ctx, lines)).toBeNull();
        expect(pi.stateOf(world.run.game).out.map((one) => [one.name, one.why])).toEqual([["Ben", "void"]]);
        expect(pi.stateOf(world.run.game).rising).toBe(true);
        const risingLines = lines.filter((line) => line.includes("void is rising"));
        expect(risingLines).toHaveLength(1);
        const again: string[] = [];
        await game.tick(world.ctx, again);
        expect(again.some((line) => line.includes("void is rising"))).toBe(false);
    });

    it("stirs in each twist due once, a bonus drop given from the loop when the pack is off", async () => {
        const run = runOf(["Ana", "Ben"], { voidAfter: 0 });
        const world = contextFor(run);
        world.place({ Ana: spot(0), Ben: spot(1) });
        world.at(pi.TWIST_MS * 3 + 10);
        const lines: string[] = [];
        await game.tick(world.ctx, lines);
        expect(pi.stateOf(world.run.game).twists).toBe(3);
        expect(lines.filter((line) => line.includes("Twist:"))).toHaveLength(3);
    });

    it("tears its pack switch and tags down at the end", () => {
        const run = runOf(["Ana"]);
        expect(game.endLines!(run)).toEqual(expect.arrayContaining([...pi.STOP_LINES]));
        expect(game.closeLines!(run.arena!.box)).toEqual(expect.arrayContaining([...pi.STOP_LINES]));
    });

    it("reads in both languages", () => {
        for (const why of ["fell", "void", "died", "left", "gone"] as const) {
            expect(said.outLine("Ana", why, null, 2, "en")).toContain("Ana");
            expect(said.outLine("Ana", why, "Ben", 2, "es")).toContain("Ben");
        }
        for (const twist of pi.TWISTS) {
            const en = said.twistLine(twist, "en");
            const es = said.twistLine(twist, "es");
            expect(es.length).toBeLessThanOrEqual(en.length + Math.max(3, Math.ceil(en.length * 0.25)));
        }
        expect(said.bar(3, "1:00", true, "es")).toContain("vacío");
    });
});
