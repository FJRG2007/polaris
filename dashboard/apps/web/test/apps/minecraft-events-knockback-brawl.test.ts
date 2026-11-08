/**
 * Knockback brawl: the options and their bounds, the stick handed out in each
 * version's spelling, a platform whose teardown takes everything it put down,
 * whoever falls put out with the pusher credited, and the winner - the last one
 * on the platform, or the most knock-offs at the time.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as hits from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hits";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import { gameOf } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-games";
import * as kb from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/knockback-brawl";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/knockback-brawl-messages";

type Options = catalog.EventOptions<"knockback-brawl">;

const AT = { x: 200, y: 100, z: -40 };

describe("the options", () => {
    it("defaults to Knockback 5 and takes up to 255, never past it", () => {
        const preset = catalog.newPreset("knockback-brawl", "kb");
        expect((preset.options as Options).knockback).toBe(5);
        const withLevel = (knockback: number) => ({
            ...preset,
            options: { ...preset.options, knockback }
        });
        expect(catalog.presetSchema.safeParse(withLevel(255)).success).toBe(true);
        expect(catalog.presetSchema.safeParse(withLevel(256)).success).toBe(false);
        expect(catalog.presetSchema.safeParse(withLevel(0)).success).toBe(false);
        expect(catalog.presetSchema.safeParse(withLevel(2.5)).success).toBe(false);
    });

    it("is a last-one-standing fight in a sky arena, with everybody's things put away first", () => {
        const preset = catalog.newPreset("knockback-brawl", "kb");
        expect(catalog.playsInArena(preset)).toBe(true);
        expect(catalog.heldWhere(preset)).toBe("sky");
        expect(catalog.needsPvp(preset)).toBe(true);
        expect(catalog.lastStanding(preset)).toBe(true);
        expect(catalog.stashesFirst(preset)).toBe(true);
        expect(catalog.KIND_NAMES["knockback-brawl"].es).toBe("Empujones");
    });
});

describe("the stick", () => {
    const name = said.stickName("es");

    it("is the operator's Palo con Empuje in Spanish", () => {
        expect(name).toBe("Palo con Empuje");
        expect(said.stickName("en")).toBe("Knockback Stick");
    });

    it("is written as an SNBT name and a plain enchantment map from 1.21.5", () => {
        const [own, other] = kb.stickLines("components", "text", name, 255);
        expect(own).toBe(
            `give @a[tag=${kb.IN_TAG},tag=!${kb.OUT_TAG},nbt=!{Inventory:[{id:"minecraft:stick",components:{"minecraft:custom_data":{polaris_event:1b}}}]}] minecraft:stick[minecraft:custom_data={polaris_event:1b},minecraft:custom_name={text:"Palo con Empuje",color:"gold",italic:0b},minecraft:enchantments={"minecraft:knockback":255}] 1`
        );
        // The 1.20.5 spelling after it, for a version read wrong.
        expect(other).toContain(`minecraft:enchantments={levels:{"minecraft:knockback":255}}`);
    });

    it("is written with JSON in a string and enchantment levels from 1.20.5", () => {
        const [own, other] = kb.stickLines("components", "json", name, 5);
        expect(own).toContain(
            `minecraft:stick[minecraft:custom_data={polaris_event:1b},minecraft:custom_name='{"text":"Palo con Empuje","color":"gold","italic":false}',minecraft:enchantments={levels:{"minecraft:knockback":5}}] 1`
        );
        expect(other).toContain(`minecraft:enchantments={"minecraft:knockback":5}`);
    });

    it("is written as a tag with an Enchantments list before 1.20.5", () => {
        const lines = kb.stickLines("tag", "text", name, 255);
        expect(lines).toEqual([
            `give @a[tag=${kb.IN_TAG},tag=!${kb.OUT_TAG},nbt=!{Inventory:[{id:"minecraft:stick",tag:{polaris_event:1b}}]}] minecraft:stick{polaris_event:1b,display:{Name:'{"text":"Palo con Empuje","color":"gold","italic":false}'},Enchantments:[{id:"minecraft:knockback",lvl:255s}]} 1`
        ]);
    });

    it("keeps the level to what the game reads", () => {
        expect(kb.stickItem("tag", "tag", "x", 900)).toContain("lvl:255s");
        expect(kb.stickItem("components", "text", "x", 0)).toContain(`"minecraft:knockback":1}`);
    });

    it("is taken back as the kit, and only it", () => {
        expect(gameOf("knockback-brawl")!.kit({} as never)).toEqual([kb.STICK]);
        expect(arena.clearMarked("Ana", kb.STICK, "components")).toBe(
            "clear Ana minecraft:stick[minecraft:custom_data={polaris_event:1b}]"
        );
    });
});

describe("the platform", () => {
    it("grows with who joined, everybody on their own spot on it, facing the middle", () => {
        for (const players of [2, 8, kb.MOST, 40]) {
            const layout = kb.layoutFor(players);
            const seen = new Set<string>();
            for (let index = 0; index < Math.min(players, kb.MOST); index += 1) {
                const spot = kb.startSpot(layout, AT, index);
                expect(Math.abs(spot.x - AT.x)).toBeLessThan(layout.half - 1);
                expect(Math.abs(spot.z - AT.z)).toBeLessThan(layout.half - 1);
                expect(spot.y).toBe(AT.y + 1);
                seen.add(`${spot.x},${spot.z}`);
            }
            expect(seen.size).toBe(Math.min(players, kb.MOST));
        }
        expect(kb.layoutFor(2).half).toBeLessThan(kb.layoutFor(kb.MOST).half);
    });

    it("builds a rim last, whose first corner is its own, and takes down everything it put down", () => {
        const layout = kb.layoutFor(6);
        const fills = kb.arenaFills(layout, AT);
        const last = fills[fills.length - 1]!;
        expect(last.block).toBe(kb.RIM);
        const corner = { x: last.box.x1, z: last.box.z1 };
        // Not under any earlier fill on the floor's level.
        const covered = fills
            .slice(0, -1)
            .filter((one) => one.box.y1 <= AT.y && one.box.y2 >= AT.y)
            .some(
                (one) =>
                    corner.x >= one.box.x1 &&
                    corner.x <= one.box.x2 &&
                    corner.z >= one.box.z1 &&
                    corner.z <= one.box.z2
            );
        expect(covered).toBe(false);
        const box = kb.arenaBox(layout, AT);
        for (const one of fills) {
            expect(kb.ARENA_BLOCKS).toContain(one.block);
            expect(one.box.x1).toBeGreaterThanOrEqual(box.x1);
            expect(one.box.x2).toBeLessThanOrEqual(box.x2);
            expect(one.box.y1).toBeGreaterThanOrEqual(box.y1);
            expect(one.box.y2).toBeLessThanOrEqual(box.y2);
        }
        expect(kb.topOver(64)).toBe(64 + kb.HEIGHT);
    });

    it("sends whoever crosses the play area's edge up to the gallery between ticks", () => {
        const layout = kb.layoutFor(4);
        const lines = kb.quickLines(layout, AT, kb.arenaBox(layout, AT), ["Ana", "Ben"]);
        expect(lines[0]).toBe(`tag @a[tag=${kb.IN_TAG},name=!Ana,name=!Ben] remove ${kb.IN_TAG}`);
        const seat = kb.gallerySpot(layout, AT, 0);
        expect(lines[lines.length - 1]).toContain(
            `tp @a[tag=${kb.IN_TAG},tag=!${kb.OUT_TAG},tag=${kb.GONE_TAG}] ${seat.x + 0.5} ${seat.y} ${seat.z + 0.5}`
        );
        expect(lines.filter((line) => line.includes(`add ${kb.GONE_TAG}`))).toHaveLength(6);
    });
});

describe("who wins", () => {
    const names = ["Ana", "Ben", "Cy"];
    const state = (out: string[], kills: Record<string, number> = {}) =>
        kb.stateOf({ out: out.map((name, at) => ({ name, at, why: "fell" })), kills });

    it("is the last one on the platform", () => {
        expect(kb.winnerOf(state(["Ben", "Cy"]), names)).toBe("Ana");
        expect(kb.standing(state(["ben"]), names)).toEqual(["Ana", "Cy"]);
    });

    it("is, at the time, the most knock-offs among those still standing - nobody on a tie", () => {
        expect(kb.winnerOf(state(["Cy"], { Ana: 1, Ben: 2, Cy: 5 }), names)).toBe("Ben");
        expect(kb.winnerOf(state([], { Ana: 1, Ben: 1 }), names)).toBeNull();
    });

    it("ranks by the order they fell, the knock-offs breaking a tie", () => {
        const game = gameOf("knockback-brawl")!;
        const run = { entrants: names.map((name) => ({ name })), game: state(["Cy"], { Ben: 2 }) };
        expect(Object.fromEntries(game.results(run as never))).toEqual({ Ana: 2, Ben: 2, Cy: 1 });
        expect(game.tiebreak!(run as never)).toEqual({ Ana: -0, Ben: -2, Cy: -0 });
    });
});

describe("a tick", () => {
    const names = ["Ana", "Ben", "Cy"];
    const layout = kb.layoutFor(names.length);
    const ground = { x: AT.x, y: AT.y - kb.HEIGHT, z: AT.z };
    const where = (positions: Record<string, { x: number; y: number; z: number }>) =>
        Object.entries(positions)
            .map(
                ([name, at]) =>
                    `${name} has the following entity data: [${at.x.toFixed(1)}d, ${at.y.toFixed(1)}d, ${at.z.toFixed(1)}d]`
            )
            .join("\n");
    const onPlatform = (index: number) => {
        const spot = kb.startSpot(layout, AT, index);
        return { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 };
    };

    it("puts out whoever fell, credits whoever pushed them, and ends with one left", async () => {
        const game = gameOf("knockback-brawl")!;
        let positions: Record<string, { x: number; y: number; z: number }> = {
            Ana: onPlatform(0),
            Ben: onPlatform(1),
            Cy: onPlatform(2)
        };
        let taken: Record<string, number> = { Ana: 0, Ben: 0, Cy: 0 };
        const sent: string[] = [];
        const ctx = {
            server: {
                say: async (lines: string[]) => {
                    const line = lines[0]!;
                    sent.push(...lines);
                    if (line === commands.IN_OVERWORLD) return where(positions);
                    if (line.includes("pe_swt"))
                        return Object.entries(taken)
                            .map(([name, value]) => `${name} has ${value} [pe_swt]`)
                            .join("\n");
                    if (line === hits.attackerLine("Ben")) return where({ Ana: positions.Ana! });
                    return "";
                }
            },
            language: "en",
            home: "en",
            now: 1_000_000,
            run: {
                id: "kb-run",
                preset: catalog.newPreset("knockback-brawl", "kb"),
                joined: names,
                entrants: names.map((name, side) => ({ name, side })),
                place: ground,
                arena: { box: kb.arenaBox(layout, AT) },
                marker: "components",
                game: { design: kb.DESIGN, spelling: "text" },
                readyAt: 990_000,
                endsAt: 1_300_000
            },
            persist: async () => {},
            atLeast: async () => true
        };
        const tick = async (now: number) => {
            ctx.now = now;
            const lines: string[] = [];
            const decided = await game.tick(ctx as never, lines);
            return { decided, lines };
        };
        // Everybody standing: kept unhurt, a stick for whoever has none.
        const first = await tick(1_000_000);
        expect(first.decided).toBeNull();
        expect(first.lines).toEqual(expect.arrayContaining([...kb.PLAY_EFFECTS]));
        expect(first.lines.some((line) => line.startsWith(`give @a[tag=${kb.IN_TAG}`))).toBe(true);
        // Ana strikes Ben, then Ben goes over the edge and under the platform.
        taken = { ...taken, Ben: 10 };
        await tick(1_001_000);
        positions = { ...positions, Ben: { x: AT.x, y: AT.y - 10, z: AT.z } };
        const second = await tick(1_002_000);
        expect(second.decided).toBeNull();
        let kept = kb.stateOf(ctx.run.game);
        expect(kept.out.map((one) => [one.name, one.why])).toEqual([["Ben", "fell"]]);
        expect(kept.kills).toEqual({ Ana: 1 });
        expect(second.lines).toContain(`tag Ben add ${kb.OUT_TAG}`);
        expect(second.lines).toContain(
            "clear Ben minecraft:stick[minecraft:custom_data={polaris_event:1b}]"
        );
        // Cy falls on their own: nobody credited, and Ana is the last one left.
        positions = { ...positions, Cy: { x: AT.x + 40, y: AT.y - 20, z: AT.z } };
        const third = await tick(1_030_000);
        expect(third.decided).toBe(said.LAST_ONE);
        kept = kb.stateOf(ctx.run.game);
        expect(kept.out.map((one) => one.name)).toEqual(["Ben", "Cy"]);
        expect(kept.kills).toEqual({ Ana: 1 });
        expect(kb.winnerOf(kept, names)).toBe("Ana");
        const results = game.resultLines(ctx.run as never, "en", new Set());
        expect(results.join("\n")).toContain("is the last one on the platform and wins.");
        expect(game.resultLines(ctx.run as never, "en", new Set(["ana"]))).toEqual([]);
    });
});
