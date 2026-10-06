/**
 * The dropper's shaft (`kinds/dropper`): its plan checked against its rules
 * over thousands of runs, a player actually falling it - steering tick by tick
 * with the game's own air control - and the boxes it is built of, block by block.
 */

import { describe, expect, it } from "vitest";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/dropper-messages";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as dropper from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/dropper";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const LEVELS = [5, 10, 15, 20];
const SEEDS = 500;

/**
 * A player falling the shaft from the spawn, steering for each hole the way a
 * careful player does, with the game's own air control - walking, never
 * sprinting: heading for the point the plan passes the hole at (`through`),
 * pushing toward it until they would only just stop in time, then pushing back
 * to a standstill. They steer for a hole only once their head is under the
 * floor above it, and until then slow down. Their 0.6 by 1.8 box is checked against every floor block it meets.
 * Answers the floor they landed on, or null when they reached the water.
 */
function fall(shaft: dropper.Shaft): number | null {
    const {
        airAcceleration: push,
        horizontalDrag: drag,
        gravity,
        verticalDrag,
        width,
        height
    } = dropper.PHYSICS;
    const half = width / 2;
    const world = (point: dropper.Point) => ({
        x: shaft.center.x - dropper.HALF + point.x,
        z: shaft.center.z - dropper.HALF + point.z
    });
    const spawn = world(dropper.SPAWN);
    let x = spawn.x;
    let z = spawn.z;
    let y = shaft.top + 1;
    let vx = 0;
    let vz = 0;
    let vy = 0;
    // How far a speed carries on while pushing back until it is down to `end`.
    const stopping = (speed: number, end: number) => {
        let v = speed;
        let moved = 0;
        while (v > end + 1e-6) {
            v = (v - Math.min(push, v - end)) * drag;
            moved += v / drag;
        }
        return moved;
    };
    let level = 0;
    for (let tick = 0; tick < 100_000 && level < shaft.floors.length; tick += 1) {
        const above = level === 0 ? shaft.top : shaft.floors[level - 1]!;
        const clear = y + height <= above;
        const target = world(shaft.plan.levels[level]!.through);
        const ex = target.x - x;
        const ez = target.z - z;
        const distance = Math.hypot(ex, ez);
        const speed = Math.hypot(vx, vz);
        let ax = 0;
        let az = 0;
        const along = distance > 1e-9 ? (vx * ex + vz * ez) / distance : 0;
        // Pushing on this tick moves them `along + push` and leaves them that,
        // dragged, to stop from: past the point, and they push back instead.
        const overshoots = along + push + stopping((along + push) * drag, 0) > distance;
        if (!clear || distance <= 0.02 || (along > 0 && overshoots)) {
            // Back against the way they are going, no harder than stops them.
            const scale = Math.min(1, speed / push);
            ax = speed > 0 ? (-vx / speed) * scale : 0;
            az = speed > 0 ? (-vz / speed) * scale : 0;
        } else if (distance > 1e-9) {
            ax = ex / distance;
            az = ez / distance;
        }
        vx += ax * push;
        vz += az * push;
        x += vx;
        z += vz;
        y += vy;
        vy = (vy - gravity) * verticalDrag;
        vx *= drag;
        vz *= drag;
        // In a floor's block: inside its hole, or landed on it.
        const floor = shaft.floors[level]!;
        const hole = shaft.holes[level]!;
        if (y < floor + 1 && y + height > floor) {
            const inside =
                x - half >= hole.x1 &&
                x + half <= hole.x2 + 1 &&
                z - half >= hole.z1 &&
                z + half <= hole.z2 + 1;
            if (!inside) return level + 1;
        }
        if (y + height <= floor) level += 1;
    }
    return null;
}
const shaftOf = (difficulty: (typeof DIFFICULTIES)[number], levels: number, seed: string) =>
    dropper.shaft({ levels, difficulty }, seed, { x: 40, z: -12 }, 90);

describe("a dropper's shaft", () => {
    it("keeps every rule, and a careful player makes every hole, over thousands of runs", () => {
        const report: string[] = [];
        let plans = 0;
        for (const difficulty of DIFFICULTIES)
            for (const levels of LEVELS) {
                let broke = 0;
                let missed = 0;
                let tallest = 0;
                let needs = 0;
                let drops = 0;
                for (let seed = 0; seed < SEEDS; seed += 1) {
                    const shaft = shaftOf(difficulty, levels, `run-${seed}`);
                    const problems = dropper.planProblems(shaft.plan);
                    if (problems.length > 0) {
                        broke += 1;
                        if (broke === 1) report.push(`${difficulty} ${levels}: ${problems[0]}`);
                    }
                    const landed = fall(shaft);
                    if (landed !== null) {
                        missed += 1;
                        if (missed === 1)
                            report.push(`${difficulty} ${levels} run-${seed}: landed on ${landed}`);
                    }
                    tallest = Math.max(tallest, shaft.volume.y2 - shaft.volume.y1 + 1);
                    needs += shaft.plan.levels.reduce((sum, one) => sum + one.need, 0) / levels;
                    drops += shaft.plan.levels.reduce((sum, one) => sum + one.drop, 0) / levels;
                    plans += 1;
                }
                report.push(
                    `${difficulty} ${levels}: ${broke} broke a rule, ${missed} missed, tallest ${tallest}, mean move ${(needs / SEEDS).toFixed(2)}, mean drop ${(drops / SEEDS).toFixed(1)}`
                );
                expect(broke, report.join("\n")).toBe(0);
                expect(missed, report.join("\n")).toBe(0);
                // Fits over the sea and under a 1.18 world's build limit (319),
                // with its lift: twenty hard floors included.
                expect(tallest + dropper.LIFT + 63, report.join("\n")).toBeLessThanOrEqual(319);
            }
        expect(plans).toBe(DIFFICULTIES.length * LEVELS.length * SEEDS);
    });

    it("lays out the same shaft for the same run, and another for another", () => {
        const one = shaftOf("medium", 10, "same");
        expect(shaftOf("medium", 10, "same")).toEqual(one);
        expect(shaftOf("medium", 10, "other").holes).not.toEqual(one.holes);
    });

    it("never lets a straight drop through a hole skip the next floor", () => {
        for (const difficulty of DIFFICULTIES)
            for (let seed = 0; seed < 300; seed += 1) {
                const shaft = shaftOf(difficulty, 12, `straight-${seed}`);
                // Falling straight from the spawn lands on the first floor.
                const spawn = dropper.spawn(shaft);
                const first = shaft.holes[0]!;
                expect(
                    spawn.x - 0.3 >= first.x1 &&
                        spawn.x + 0.3 <= first.x2 + 1 &&
                        spawn.z - 0.3 >= first.z1 &&
                        spawn.z + 0.3 <= first.z2 + 1
                ).toBe(false);
                // And no two holes in a row share a column.
                for (let index = 1; index < shaft.holes.length; index += 1) {
                    const a = shaft.holes[index - 1]!;
                    const b = shaft.holes[index]!;
                    const shared = a.x1 <= b.x2 && b.x1 <= a.x2 && a.z1 <= b.z2 && b.z1 <= a.z2;
                    expect(shared).toBe(false);
                }
            }
    });

    it("gets harder: smaller holes and further to go between them", () => {
        const mean = (difficulty: (typeof DIFFICULTIES)[number]) => {
            let total = 0;
            for (let seed = 0; seed < 200; seed += 1)
                total += shaftOf(difficulty, 10, `hard-${seed}`).plan.levels.reduce(
                    (sum, one) => sum + one.need,
                    0
                );
            return total;
        };
        expect(dropper.STEPS.easy.hole).toBeGreaterThan(dropper.STEPS.medium.hole);
        expect(dropper.STEPS.medium.hole).toBeGreaterThan(dropper.STEPS.hard.hole);
        expect(mean("easy")).toBeLessThan(mean("medium"));
        expect(mean("medium")).toBeLessThan(mean("hard"));
    });

    it("works out the air control and the fall as the game does", () => {
        // A tick in the air: the push (0.02 x 0.98 walking), the move, then 0.91 drag.
        expect(dropper.airTick(0, 1)).toEqual({ speed: 0.0196 * 0.91, moved: 0.0196 });
        expect(dropper.airTick(0.1, -1).moved).toBeCloseTo(0.1 - 0.0196, 9);
        // From still to still: never further than pushing all the way, never less
        // with more time, and settled by measuring once (20 ticks: 1.97 blocks).
        let pushed = 0;
        let speed = 0;
        for (let ticks = 1; ticks <= 60; ticks += 1) {
            const step = dropper.airTick(speed, 1);
            speed = step.speed;
            pushed += step.moved;
            expect(dropper.reachIn(ticks)).toBeLessThanOrEqual(pushed + 1e-9);
            expect(dropper.reachIn(ticks)).toBeGreaterThanOrEqual(dropper.reachIn(ticks - 1));
        }
        expect(dropper.reachIn(1)).toBeCloseTo(0.0196, 9);
        expect(dropper.reachIn(20)).toBeCloseTo(1.965, 2);
        // Under Slow Falling the fall settles at 0.49 of a block a tick.
        const long = dropper.fallTicks({ y: 0, velocity: 0 }, 10, -400);
        expect(long.fall.velocity).toBeCloseTo(-0.49, 2);
        // The first tick of a fall: moved by nothing, then 0.01 less, dragged.
        expect(dropper.fallTick({ y: 5, velocity: 0 })).toEqual({ y: 5, velocity: -0.01 * 0.98 });
    });

    it("is never in the air longer than the server lets a player be", () => {
        // The server's own limit before "Flying is not enabled on this server":
        // 80 ticks, times how much lighter than 0.08 the player's gravity is
        // (`ServerGamePacketListenerImpl.getMaximumFlyingTicks`).
        const limit = (gravity: number) => Math.ceil(80 * Math.max(0.08 / gravity, 1));
        // What happened before: let go from the top at y 224 under Slow Falling
        // alone, both racers were kicked at y 204.0404329834322 - exactly where
        // that fall is on its 81st tick, the first one over the limit.
        let fall: dropper.Fall = { y: 224, velocity: 0 };
        for (let tick = 0; tick <= limit(0.08); tick += 1) fall = dropper.fallTick(fall);
        expect(fall.y).toBeCloseTo(204.0404329834322, 4);
        // The lighter gravity is Slow Falling's own, so the fall is unchanged...
        expect(stage.LIGHT_GRAVITY).toBe(dropper.PHYSICS.gravity);
        expect(0.08 * (1 + Number(stage.lightFallLines("Ana")[0]!.split(" ").at(-2)))).toBeCloseTo(
            stage.LIGHT_GRAVITY,
            12
        );
        // ...and the deepest shaft, fallen from the lid to the water without
        // touching a floor, takes well under the limit it gives.
        let longest = 0;
        for (const difficulty of DIFFICULTIES)
            for (let seed = 0; seed < 200; seed += 1) {
                const shaft = dropper.shaft({ levels: 20, difficulty }, `deep-${seed}`, { x: 0, z: 0 }, 60);
                let falling: dropper.Fall = { y: shaft.top + 1, velocity: 0 };
                let ticks = 0;
                while (falling.y > shaft.water) {
                    falling = dropper.fallTick(falling);
                    ticks += 1;
                }
                longest = Math.max(longest, ticks);
            }
        expect(longest).toBeGreaterThan(limit(0.08));
        expect(longest).toBeLessThan(limit(stage.LIGHT_GRAVITY) - 60);
    });

    it("lends a racer the lighter fall by name, under both names of the attribute, and takes it back", () => {
        expect(stage.lightFallLines("Ana")).toEqual([
            "attribute Ana minecraft:gravity modifier add polaris:event_light_fall -0.875 add_multiplied_base",
            "attribute Ana minecraft:generic.gravity modifier add polaris:event_light_fall -0.875 add_multiplied_base"
        ]);
        expect(stage.normalFallLines("Ana")).toEqual([
            "attribute Ana minecraft:gravity modifier remove polaris:event_light_fall",
            "attribute Ana minecraft:generic.gravity modifier remove polaris:event_light_fall"
        ]);
        // Every way home takes it off.
        const saved: stage.Saved = {
            name: "Ana",
            dimension: "minecraft:overworld",
            x: 0,
            y: 64,
            z: 0,
            yaw: 0,
            pitch: 0,
            mode: "survival"
        };
        const after = stage.afterReturnLines(saved, "components", "&7Back");
        for (const line of stage.normalFallLines("Ana")) expect(after).toContain(line);
        for (const line of [
            ...stage.lightFallLines("Maximilian_1234"),
            ...stage.normalFallLines("Maximilian_1234")
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });

    it("is built of boxes that never share a block, inside its volume, the water held in", () => {
        const wrong: string[] = [];
        const check = (ok: boolean, what: string) => {
            if (!ok && wrong.length < 20) wrong.push(what);
        };
        let shafts = 0;
        for (const difficulty of DIFFICULTIES)
            for (let seed = 0; seed < 30; seed += 1) {
                const levels = 5 + (seed % 16);
                const shaft = shaftOf(difficulty, levels, `boxes-${seed}`);
                const blocks = new Map<string, string>();
                for (const box of shaft.boxes) {
                    check(stage.ARENA_BLOCKS.includes(box.block), `${box.block} is no arena block`);
                    check(stage.volumeOf(box) <= stage.FILL_LIMIT, "a box too big for one fill");
                    check(
                        box.x1 >= shaft.volume.x1 &&
                            box.x2 <= shaft.volume.x2 &&
                            box.y1 >= shaft.volume.y1 &&
                            box.y2 <= shaft.volume.y2 &&
                            box.z1 >= shaft.volume.z1 &&
                            box.z2 <= shaft.volume.z2,
                        "a box outside the volume"
                    );
                    for (let x = box.x1; x <= box.x2; x += 1)
                        for (let y = box.y1; y <= box.y2; y += 1)
                            for (let z = box.z1; z <= box.z2; z += 1) {
                                const key = `${x} ${y} ${z}`;
                                check(!blocks.has(key), `${key} in two boxes`);
                                blocks.set(key, box.block);
                            }
                }
                const { x: cx, z: cz } = shaft.center;
                const outer = dropper.HALF + 1;
                // A wall all round with no gap, from the pool up to the rail.
                for (let y = shaft.bottom; y <= shaft.top + 3; y += 1)
                    for (let i = -outer; i <= outer; i += 1)
                        for (const [x, z] of [
                            [cx + i, cz - outer],
                            [cx + i, cz + outer],
                            [cx - outer, cz + i],
                            [cx + outer, cz + i]
                        ])
                            check(
                                blocks.has(`${x} ${y} ${z}`),
                                `a gap in the wall at ${x} ${y} ${z}`
                            );
                // Each floor is whole but for its hole, lit round it, with nothing
                // in the air between it and the next.
                shaft.floors.forEach((floor, index) => {
                    const hole = shaft.holes[index]!;
                    const next = shaft.floors[index + 1] ?? shaft.water;
                    check(floor - next - 1 >= 3, `no head room under floor ${index + 1}`);
                    for (let x = cx - dropper.HALF; x <= cx + dropper.HALF; x += 1)
                        for (let z = cz - dropper.HALF; z <= cz + dropper.HALF; z += 1) {
                            const open =
                                x >= hole.x1 && x <= hole.x2 && z >= hole.z1 && z <= hole.z2;
                            check(
                                blocks.has(`${x} ${floor} ${z}`) === !open,
                                `floor ${index + 1} at ${x} ${z}`
                            );
                            for (let y = next + 1; y < floor; y += 1)
                                check(
                                    !blocks.has(`${x} ${y} ${z}`),
                                    `in the air at ${x} ${y} ${z}`
                                );
                        }
                    for (const [x, z] of [
                        [hole.x1 - 1, hole.z1 - 1],
                        [hole.x2 + 1, hole.z2 + 1]
                    ])
                        check(
                            blocks.get(`${x} ${floor} ${z}`) === "minecraft:sea_lantern",
                            "an unlit hole"
                        );
                    // A band of its own color round the outside, unlike the one above.
                    if (index > 0)
                        check(
                            blocks.get(`${cx} ${floor} ${cz - outer}`) !==
                                blocks.get(`${cx} ${shaft.floors[index - 1]!} ${cz - outer}`),
                            "two floors of one color"
                        );
                });
                // The water fills the bottom, over a floor, inside the wall - built
                // last, so it is taken out first.
                for (let y = shaft.bottom + 1; y <= shaft.water; y += 1)
                    for (let x = cx - dropper.HALF; x <= cx + dropper.HALF; x += 1)
                        check(
                            blocks.get(`${x} ${y} ${cz}`) === dropper.WATER,
                            `no water at ${x} ${y}`
                        );
                check(
                    /_concrete$/.test(blocks.get(`${cx} ${shaft.bottom} ${cz}`) ?? ""),
                    "no pool floor"
                );
                check(shaft.boxes.at(-1)!.block === dropper.WATER, "the water not last");
                check(blocks.get(`${cx} ${shaft.top} ${cz}`) === "minecraft:glass", "no lid");
                check(shaft.lid.block === "minecraft:glass", "a lid not of glass");
                shafts += 1;
            }
        expect(wrong).toEqual([]);
        expect(shafts).toBe(90);
    });

    it("counts the floors a player fell through", () => {
        const shaft = shaftOf("easy", 6, "count");
        expect(dropper.floorsPassed(shaft, shaft.top + 1)).toBe(0);
        expect(dropper.floorsPassed(shaft, shaft.floors[0]! + 1)).toBe(0);
        expect(dropper.floorsPassed(shaft, shaft.floors[0]! - 0.5)).toBe(1);
        expect(dropper.floorsPassed(shaft, shaft.water)).toBe(6);
    });
});

describe("the dropper's data pack", () => {
    const files = snowballPack.packFiles();
    const fn = (name: string) =>
        files.get(`data/polaris/function/dropper/${name}.mcfunction`)!.trimEnd().split("\n");
    const shaft = shaftOf("medium", 8, "pack");

    it("is part of the events pack, in both spellings of the function folders", () => {
        for (const folder of ["functions", "function"]) {
            expect(
                JSON.parse(files.get(`data/minecraft/tags/${folder}/tick.json`)!).values
            ).toContain("polaris:dropper/tick");
            for (const name of Object.keys(dropper.FUNCTIONS))
                expect(files.get(`data/polaris/${folder}/dropper/${name}.mcfunction`)).toBe(
                    `${dropper.FUNCTIONS[name]!.join("\n")}\n`
                );
        }
        expect(fn("tick")).toEqual([
            "execute if score #on polaris_drop matches 1 in minecraft:overworld as @a[tag=pe_in,distance=0..] run function polaris:dropper/player"
        ]);
        for (const lines of Object.values(dropper.FUNCTIONS))
            for (const line of lines) {
                expect(line.length).toBeLessThan(32_500);
                // It moves players and keeps scores: it never builds or breaks.
                expect(line).not.toMatch(/\b(fill|setblock|clone)\b/);
            }
    });

    it("sends a racer who stands on anything over the floors back to the top, the tick they do", () => {
        expect(fn("player").at(-1)).toContain("execute if entity @s[scores={pe_drop=0}]");
        expect(fn("player").at(-1)).toContain("if score #pz polaris_drop <= #sz2 polaris_drop");
        const racer = fn("racer");
        expect(racer[0]).toBe("scoreboard players operation @s pe_low < #py polaris_drop");
        // Sent up once: the server's OnGround is the floor's until the player's
        // game answers the teleport, and sending them up every tick until then
        // held them in the air until the server kicked them for flying.
        expect(racer[1]).toBe(
            "tag @s[tag=polaris_drop_sent,nbt={OnGround:0b}] remove polaris_drop_sent"
        );
        expect(racer[2]).toMatch(
            /^execute if entity @s\[tag=!polaris_drop_sent,nbt=\{OnGround:1b\}\] if score #px polaris_drop >= #fx1 polaris_drop .* run function polaris:dropper\/back$/
        );
        expect(racer[3]).toBe(
            "execute if score #py polaris_drop <= #wy polaris_drop run function polaris:dropper/done"
        );
        expect(fn("back").slice(0, 2)).toEqual([
            "tp @s @e[type=minecraft:armor_stand,tag=polaris_drop_top,limit=1]",
            "tag @s add polaris_drop_sent"
        ]);
        expect(fn("done")[0]).toBe("execute store result score @s pe_drop run time query gametime");
    });

    it("is armed for one shaft, switch last, and only that shaft's end switches it off", () => {
        const lines = dropper.armLines(shaft);
        const { x, z } = shaft.center;
        const lowest = shaft.floors.at(-1)!;
        expect(lines.indexOf("scoreboard players set #on polaris_drop 0")).toBeLessThan(
            lines.findIndex((line) => line.includes("#sx1"))
        );
        expect(lines).toContain(`scoreboard players set #sx1 polaris_drop ${(x - 5) * 64}`);
        expect(lines).toContain(`scoreboard players set #sx2 polaris_drop ${(x + 6) * 64 - 1}`);
        expect(lines).toContain(
            `scoreboard players set #fy1 polaris_drop ${(lowest + 1) * 64 - 16}`
        );
        expect(lines).toContain(
            `scoreboard players set #fy2 polaris_drop ${(shaft.top + 1) * 64 - 1}`
        );
        // Where a racer is let fall from - at "Go!" and each time they are sent
        // back - is never a landing: `tp` leaves its target on the ground, and
        // with the spot inside, the pack sent them back to it every tick,
        // holding them in mid-air until the server kicked them for floating.
        const fy2 = (shaft.top + 1) * 64 - 1;
        expect(dropper.spawn(shaft).y * 64).toBeGreaterThan(fy2);
        expect(
            Number(/summon minecraft:armor_stand \S+ (\S+) /.exec(lines.join("\n"))![1]) * 64
        ).toBeGreaterThan(fy2);
        // The first floor's own landing is still one.
        expect((shaft.floors[0]! + 1) * 64).toBeLessThanOrEqual(fy2);
        expect(lines).toContain(
            `scoreboard players set #wy polaris_drop ${(shaft.water + 1) * 64}`
        );
        expect(lines.find((line) => line.includes("summon"))).toContain(
            `summon minecraft:armor_stand ${x + 0.5} ${shaft.top + 1} ${z + 0.5} {Tags:["polaris_drop_top"]`
        );
        expect(lines.at(-1)).toBe("scoreboard players set #on polaris_drop 1");
        // The water's corner names the shaft.
        const ours = `if score #sx1 polaris_drop matches ${(x - 5) * 64} if score #sz1 polaris_drop matches ${(z - 5) * 64}`;
        expect(dropper.stopLines(shaft.boxes)).toEqual([
            `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=polaris_drop_top]`,
            `execute ${ours} run tag @a remove polaris_drop_sent`,
            `execute ${ours} run scoreboard players set #on polaris_drop 0`
        ]);
        expect(dropper.stopLines(shaft.boxes.filter((box) => box.block !== dropper.WATER))).toEqual(
            []
        );
        // The lid goes only where it is still glass.
        expect(dropper.lidGone(shaft)).toBe(
            `execute in minecraft:overworld run fill ${x - 5} ${shaft.top} ${z - 5} ${x + 5} ${shaft.top} ${z + 5} minecraft:air replace minecraft:glass`
        );
        // A racer let go: unfinished, at the top, not sent back yet.
        expect(dropper.racerScores("Ana", shaft)).toEqual([
            "scoreboard players set Ana pe_drop 0",
            `scoreboard players set Ana pe_low ${(shaft.top + 1) * 64}`,
            "scoreboard players set Ana pe_back 0",
            "tag Ana remove polaris_drop_sent"
        ]);
        expect(dropper.backLines('"x"')).toEqual([
            'execute as @a[tag=pe_in,scores={pe_back=1..}] run tellraw @s "x"',
            "scoreboard players set @a[tag=pe_in,scores={pe_back=1..}] pe_back 0"
        ]);
    });
});

describe("what a dropper says", () => {
    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const) {
            const words = [
                said.readySubtitle(language),
                said.goSubtitle(language),
                said.bar(20, 20, 20, language),
                said.backToTop(language),
                said.cannotPlay(language)
            ];
            for (const line of words) {
                expect(line).toMatch(/^&[0-9a-f]/);
                expect(
                    commandBytes(`tellraw Maximilian_1234 ${commands.text(line)}`)
                ).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            }
            expect(said.backToTop("en")).not.toBe(said.backToTop("es"));
        }
        const shaft = dropper.shaft(
            { levels: 20, difficulty: "hard" },
            "far",
            { x: -29_999_000, z: 29_999_000 },
            60
        );
        for (const line of [
            ...dropper.armLines(shaft),
            ...dropper.stopLines(shaft.boxes),
            ...dropper.racerScores("Maximilian_1234", shaft),
            ...dropper.backLines(commands.text(said.backToTop("es"))),
            dropper.lidGone(shaft),
            dropper.READ_LOWEST,
            dropper.READ_FINISHED
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});
