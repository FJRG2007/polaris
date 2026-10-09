/**
 * A meteor's infection (`kinds/meteor-infection`): grown over thousands of
 * seeded showers against a world of the game's own ground and players' builds,
 * it never leaves its bounds, never grows on anything but air over ground, and
 * the end takes away exactly what is still a vein.
 */

import { describe, expect, it } from "vitest";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import { seeded } from "@polaris-app/game-servers/src/lib/minecraft/events/trivia-bank";
import * as infection from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/meteor-infection";

type Point = { x: number; y: number; z: number };
const key = (point: Point) => `${point.x},${point.y},${point.z}`;

/**
 * A small world the game's way: ground (`stone`) under a bumpy surface, some
 * columns built on by players (`planks`, which is not the ground veins grow
 * on), air above. Answers a `growLine` as the game would, reading the line
 * itself: every `if block` it asks, then the `setblock ... keep`.
 */
function world(seed: string, meteor: Point) {
    const random = seeded(seed);
    const blocks = new Map<string, string>();
    for (let x = meteor.x - 12; x <= meteor.x + 12; x += 1)
        for (let z = meteor.z - 12; z <= meteor.z + 12; z += 1) {
            const top = meteor.y - 1 + (random() < 0.2 ? (random() < 0.5 ? -1 : 1) : 0);
            for (let y = top - 3; y <= top; y += 1) blocks.set(key({ x, y, z }), "minecraft:stone");
            if (random() < 0.1) blocks.set(key({ x, y: top + 1, z }), "minecraft:oak_planks");
        }
    const get = (x: number, y: number, z: number) =>
        blocks.get(`${x},${y},${z}`) ?? "minecraft:air";
    const matches = (block: string, wanted: string) =>
        wanted === "#minecraft:sculk_replaceable"
            ? block === "minecraft:stone"
            : block === wanted.replace(/\[.*$/, "");
    const say = (line: string): string => {
        const tests = [...line.matchAll(/if block (-?\d+) (-?\d+) (-?\d+) (\S+)/g)];
        for (const [, x, y, z, wanted] of tests)
            if (!matches(get(Number(x), Number(y), Number(z)), wanted!)) return "";
        const set = /run setblock (-?\d+) (-?\d+) (-?\d+) (\S+) keep$/.exec(line);
        if (!set) throw new Error(`not a grow line: ${line}`);
        const at = { x: Number(set[1]), y: Number(set[2]), z: Number(set[3]) };
        if (get(at.x, at.y, at.z) !== "minecraft:air") return "Could not set the block";
        blocks.set(key(at), set[4]!.replace(/\[.*$/, ""));
        return `Changed the block at ${at.x}, ${at.y}, ${at.z}`;
    };
    return { blocks, get, say };
}

describe("a meteor's infection", () => {
    it("keeps every rule over thousands of seeded showers", () => {
        const problems: string[] = [];
        let grown = 0;
        for (let seed = 0; seed < 1500; seed += 1) {
            const meteors = [
                { x: 0, y: 70, z: 0, infected: [] as Point[], missed: [] as Point[] },
                { x: 40, y: 64, z: -30, infected: [] as Point[], missed: [] as Point[] }
            ];
            const worlds = meteors.map((meteor, index) => world(`w-${seed}-${index}`, meteor));
            const before = worlds.map((one) => new Map(one.blocks));
            const random = seeded(`grow-${seed}`);
            const ticks = 20 + (seed % 120);
            for (let turn = 0; turn < ticks; turn += 1) {
                const tries = infection.plan(meteors, turn, random);
                if (tries.length > infection.BUDGET) problems.push(`${seed}: over budget`);
                for (const one of tries) {
                    const meteor = meteors[one.meteor]!;
                    const answer = worlds[one.meteor]!.say(infection.growLine(one.to, one.from));
                    if (infection.grew(answer)) meteor.infected.push(one.to);
                    else meteor.missed.push(one.to);
                }
                // Now and then a player breaks a vein: cleansed.
                for (const [index, meteor] of meteors.entries())
                    if (meteor.infected.length > 0 && random() < 0.1) {
                        const cell =
                            meteor.infected[Math.floor(random() * meteor.infected.length)]!;
                        worlds[index]!.blocks.delete(key(cell));
                    }
            }
            for (const [index, meteor] of meteors.entries()) {
                const { get } = worlds[index]!;
                const seen = new Set<string>();
                if (meteor.infected.length + meteor.missed.length > infection.MAX_CELLS)
                    problems.push(`${seed}: too many`);
                for (const cell of meteor.infected) {
                    if (seen.has(key(cell))) problems.push(`${seed}: infected twice`);
                    seen.add(key(cell));
                    if (
                        Math.max(Math.abs(cell.x - meteor.x), Math.abs(cell.z - meteor.z)) >
                        infection.RADIUS
                    )
                        problems.push(`${seed}: beyond its radius`);
                    // Only ever into air, over the game's own ground.
                    if (before[index]!.has(key(cell))) problems.push(`${seed}: over a block`);
                    if (get(cell.x, cell.y - 1, cell.z) !== "minecraft:stone")
                        problems.push(`${seed}: not over ground`);
                }
                grown += meteor.infected.length;
                // The end: only what is still a vein goes, and then the world
                // is as it was before, but for what players broke.
                const ends = meteor.infected.map(infection.removeIfVein);
                for (const line of ends) {
                    const [, x, y, z] =
                        /if block (-?\d+) (-?\d+) (-?\d+) minecraft:sculk_vein/.exec(line)!;
                    if (get(Number(x), Number(y), Number(z)) === "minecraft:sculk_vein")
                        worlds[index]!.blocks.delete(`${x},${y},${z}`);
                }
                const after = worlds[index]!.blocks;
                for (const [at, block] of after)
                    if (before[index]!.get(at) !== block)
                        problems.push(`${seed}: left ${block} at ${at}`);
                for (const [at] of before[index]!)
                    if (!after.has(at)) problems.push(`${seed}: took away ${at}`);
            }
        }
        expect(problems.slice(0, 5)).toEqual([]);
        expect(grown).toBeGreaterThan(1000);
    }, 180_000);

    it("seeds the crater's ring, and creeps from a cell still infected", () => {
        const meteor = { x: 10, y: 64, z: 10 };
        const seeds = infection.seedCells(meteor, seeded("ring"));
        expect(seeds).toHaveLength(infection.SEEDS);
        for (const cell of seeds) {
            expect(Math.max(Math.abs(cell.x - 10), Math.abs(cell.z - 10))).toBe(2);
            expect(cell.y).toBe(64);
        }
        const [first] = infection.creepCells(meteor, seeds, seeded("creep"));
        expect(infection.growLine(first!.to, first!.from)).toContain(
            `if block ${first!.from.x} ${first!.from.y} ${first!.from.z} minecraft:sculk_vein `
        );
        expect(infection.creepCells(meteor, [], seeded("none"))).toEqual([]);
    });

    it("stops trying a crater that cannot grow, once its bound is spent", () => {
        for (const [name, cleansed] of [
            ["no ground round it", false],
            ["every vein broken", true]
        ] as const) {
            const meteor = {
                x: 0,
                y: 64,
                z: 0,
                infected: cleansed ? infection.seedCells({ x: 0, y: 64, z: 0 }, seeded(name)) : [],
                missed: [] as Point[]
            };
            const random = seeded(`try-${name}`);
            let asked = 0;
            for (let turn = 0; turn < 500; turn += 1)
                for (const one of infection.plan([meteor], turn, random)) {
                    asked += 1;
                    meteor.missed.push(one.to);
                }
            expect(asked, name).toBeLessThanOrEqual(infection.MAX_CELLS);
            expect(infection.plan([meteor], 500, random), name).toEqual([]);
            expect(new Set(meteor.missed.map(key)).size, name).toBe(meteor.missed.length);
        }
    });

    it("gives every meteor its turn, however many there are", () => {
        const meteors = Array.from({ length: 30 }, (_, index) => ({
            x: index * 100,
            y: 64,
            z: 0,
            infected: [] as Point[],
            missed: [] as Point[]
        }));
        const reached = new Set<number>();
        for (let turn = 0; turn < 30; turn += 1)
            for (const one of infection.plan(meteors, turn, seeded(`t${turn}`)))
                reached.add(one.meteor);
        expect(reached.size).toBe(30);
    });

    it("hurts and slows only near its meteor, never touches the weather, and every line is one command", () => {
        const meteor = { x: -300, y: 70, z: 1200 };
        const lines = [
            ...infection.hurtLines(meteor),
            infection.sporeLine(meteor, { x: -301, y: 70, z: 1199 }),
            infection.growLine({ x: -301, y: 70, z: 1199 }, { x: -302, y: 70, z: 1199 }),
            infection.removeIfVein({ x: -301, y: 70, z: 1199 })
        ];
        for (const line of infection.hurtLines(meteor))
            expect(line).toContain(
                `positioned -299.5 70 1200.5 as @a[distance=..${infection.RADIUS + 2}]`
            );
        expect(infection.sporeLine(meteor, { x: -301, y: 70, z: 1199 })).toMatch(
            /^execute in minecraft:overworld if block -301 70 1199 minecraft:sculk_vein run particle /
        );
        expect(lines.join("\n")).not.toMatch(/\bweather\b|\bkill\b|\bclear\b/);
        for (const line of lines) expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        expect(infection.grew("Changed the block at -301, 70, 1199")).toBe(true);
        expect(infection.grew("Could not set the block")).toBe(false);
        expect(infection.grew("")).toBe(false);
    });
});
