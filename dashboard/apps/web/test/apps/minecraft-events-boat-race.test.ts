/**
 * The ice boat race's track (`kinds/boat-race`): laid out from thousands of run
 * ids and checked against its rules - a loop that never touches itself, the
 * same width all the way, a wall with no gap, right-angle turns with a straight
 * between, and gates that cut it into stretches only passed in order - then
 * built block by block, and the data pack and the quick look line by line.
 */

import { describe, expect, it } from "vitest";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boat-race-messages";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as boatRace from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boat-race";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const SEEDS = 3000;

const trackOf = (seed: string, laps = 2) => boatRace.track({ laps }, seed, { x: 120, z: -40 }, 110);

describe("an ice track", () => {
    it("keeps every rule over thousands of runs, and is seldom the plain fallback", () => {
        const report: string[] = [];
        let broke = 0;
        let fallbacks = 0;
        let shortest = Infinity;
        let longest = 0;
        let fewestTurns = Infinity;
        let mostTurns = 0;
        let widest = 0;
        const gates = new Map<number, number>();
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const layout = boatRace.laidOut(`run-${seed}`);
            const problems = boatRace.trackProblems(layout);
            if (problems.length > 0) {
                broke += 1;
                if (report.length < 5) report.push(`run-${seed}: ${problems[0]}`);
            }
            if (layout.fallback) fallbacks += 1;
            const lap = layout.points.length * boatRace.STEP;
            shortest = Math.min(shortest, lap);
            longest = Math.max(longest, lap);
            const turns = boatRace.turnsOf(layout.points).length;
            fewestTurns = Math.min(fewestTurns, turns);
            mostTurns = Math.max(mostTurns, turns);
            const us = layout.points.map((one) => one.u);
            const vs = layout.points.map((one) => one.v);
            widest = Math.max(
                widest,
                (Math.max(...us) - Math.min(...us)) * boatRace.STEP,
                (Math.max(...vs) - Math.min(...vs)) * boatRace.STEP
            );
            gates.set(layout.gates.length, (gates.get(layout.gates.length) ?? 0) + 1);
        }
        report.push(
            `${broke} broke a rule, ${fallbacks} fell back, laps ${shortest}-${longest} blocks, ${fewestTurns}-${mostTurns} turns, at most ${widest} across, gates ${JSON.stringify([...gates].sort())}`
        );
        expect(broke, report.join("\n")).toBe(0);
        // Nearly every run its own track.
        expect(fallbacks / SEEDS, report.join("\n")).toBeLessThan(0.001);
        expect(shortest).toBeGreaterThanOrEqual(boatRace.LAP.least);
        expect(longest).toBeLessThanOrEqual(boatRace.LAP.most);
        expect(fewestTurns).toBeGreaterThanOrEqual(boatRace.LEAST_TURNS);
    }, 180_000);

    it("lays out the same track for the same run, and another for another", () => {
        expect(boatRace.laidOut("same")).toEqual(boatRace.laidOut("same"));
        expect(boatRace.laidOut("same").points).not.toEqual(boatRace.laidOut("other").points);
    });

    it("finds the fallback keeps every rule itself", () => {
        // A run whose draws all failed would get it: it has to be a good track too.
        const plain = boatRace.plainLayout();
        expect(plain.fallback).toBe(true);
        expect(boatRace.trackProblems(plain)).toEqual([]);
    });

    it("is built of boxes that never share a block, of ice walled two high, inside its volume", () => {
        const wrong: string[] = [];
        const check = (ok: boolean, what: string) => {
            if (!ok && wrong.length < 20) wrong.push(what);
        };
        for (let seed = 0; seed < 60; seed += 1) {
            const track = trackOf(`boxes-${seed}`);
            const blocks = new Map<string, string>();
            for (const box of track.boxes) {
                check(stage.ARENA_BLOCKS.includes(box.block), `${box.block} is no arena block`);
                check(stage.volumeOf(box) <= stage.FILL_LIMIT, "a box too big for one fill");
                check(
                    box.x1 >= track.volume.x1 &&
                        box.x2 <= track.volume.x2 &&
                        box.y1 >= track.volume.y1 &&
                        box.y2 <= track.volume.y2 &&
                        box.z1 >= track.volume.z1 &&
                        box.z2 <= track.volume.z2,
                    "a box outside the volume"
                );
                for (let x = box.x1; x <= box.x2; x += 1)
                    for (let y = box.y1; y <= box.y2; y += 1)
                        for (let z = box.z1; z <= box.z2; z += 1) {
                            const at = `${x} ${y} ${z}`;
                            check(!blocks.has(at), `${at} in two boxes`);
                            blocks.set(at, box.block);
                        }
            }
            const y = track.floor;
            const road = boatRace.roadCells(track.layout.points);
            const ice = new Set(["minecraft:packed_ice", "minecraft:blue_ice"]);
            for (const at of road.keys()) {
                const [rx, rz] = at.split(",").map(Number) as [number, number];
                const x = rx + track.origin.x;
                const z = rz + track.origin.z;
                check(ice.has(blocks.get(`${x} ${y} ${z}`) ?? ""), `no ice at ${x} ${z}`);
                // Head room for a boat and its rider, but for the arches up high.
                for (let up = 1; up <= 4; up += 1)
                    check(!blocks.has(`${x} ${y + up} ${z}`), `in the way over ${x} ${z}`);
                // Beside the ice: ice, or a wall two high over it.
                for (let dx = -1; dx <= 1; dx += 1)
                    for (let dz = -1; dz <= 1; dz += 1) {
                        if (road.has(`${rx + dx},${rz + dz}`)) continue;
                        for (let up = 0; up <= 2; up += 1)
                            check(
                                blocks.has(`${x + dx} ${y + up} ${z + dz}`),
                                `a gap in the wall at ${x + dx} ${y + up} ${z + dz}`
                            );
                    }
            }
            // A net under all of it.
            const net = track.boxes[0]!;
            check(net.block === "minecraft:white_stained_glass" && net.y1 < y - 1, "no net");
            // Every gate's line is blue ice, edge to edge, under an arch.
            for (const [index, gate] of track.gates.entries()) {
                const spot = track.respawns[index]!;
                check(
                    blocks.get(`${Math.floor(spot.x)} ${y} ${Math.floor(spot.z)}`) ===
                        "minecraft:blue_ice",
                    `gate ${index} has no line`
                );
                check(
                    blocks.has(`${Math.floor(spot.x)} ${y + 5} ${Math.floor(spot.z)}`),
                    `gate ${index} has no arch`
                );
                check(gate.x2 - gate.x1 >= 4 && gate.z2 - gate.z1 >= 4, `gate ${index} too narrow`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it("starts everybody on the ice behind the line, facing it, never on another gate", () => {
        for (let seed = 0; seed < 200; seed += 1) {
            const track = trackOf(`grid-${seed}`);
            const road = boatRace.roadCells(track.layout.points);
            const spots = boatRace.grid(track, 16);
            const start = track.gates[0]!;
            for (const spot of spots) {
                // On ice, a boat's half width clear of the wall each side.
                for (const [dx, dz] of [
                    [0.7, 0.7],
                    [-0.7, 0.7],
                    [0.7, -0.7],
                    [-0.7, -0.7]
                ])
                    expect(
                        road.has(
                            `${Math.floor(spot.x + dx!) - track.origin.x},${Math.floor(spot.z + dz!) - track.origin.z}`
                        )
                    ).toBe(true);
                expect(spot.y).toBe(track.floor + 1);
                expect(
                    spot.x >= start.x1 &&
                        spot.x <= start.x2 + 1 &&
                        spot.z >= start.z1 &&
                        spot.z <= start.z2 + 1
                ).toBe(false);
                expect(boatRace.onGrid(track, spot)).toBe(true);
            }
            // No two racers on one spot.
            expect(new Set(spots.map((spot) => `${spot.x} ${spot.z}`)).size).toBe(16);
        }
    });

    it("counts laps and gates from the gates passed", () => {
        const track = trackOf("count", 3);
        const gates = track.gates.length;
        expect(boatRace.progressOf(track, 0)).toEqual({ lap: 1, gate: 0 });
        expect(boatRace.progressOf(track, 1)).toEqual({ lap: 1, gate: 0 });
        expect(boatRace.progressOf(track, 2)).toEqual({ lap: 1, gate: 1 });
        expect(boatRace.progressOf(track, gates + 1)).toEqual({ lap: 2, gate: 0 });
        expect(boatRace.progressOf(track, 3 * gates + 1)).toEqual({ lap: 3, gate: 0 });
    });
});

describe("the boat race's data pack", () => {
    const files = snowballPack.packFiles();
    const fn = (name: string) =>
        files.get(`data/polaris/function/boat/${name}.mcfunction`)!.trimEnd().split("\n");
    const track = trackOf("pack", 2);

    it("is part of the events pack, in both spellings of the function folders", () => {
        for (const folder of ["functions", "function"]) {
            expect(
                JSON.parse(files.get(`data/minecraft/tags/${folder}/tick.json`)!).values
            ).toContain("polaris:boat/tick");
            for (const name of Object.keys(boatRace.FUNCTIONS))
                expect(files.get(`data/polaris/${folder}/boat/${name}.mcfunction`)).toBe(
                    `${boatRace.FUNCTIONS[name]!.join("\n")}\n`
                );
        }
        for (const lines of Object.values(boatRace.FUNCTIONS))
            for (const line of lines) {
                expect(line.length).toBeLessThan(32_500);
                // Nothing in it that one version or another would not read.
                expect(line).not.toMatch(/\b(ride|summon|fill|setblock|oak_boat|minecraft:boat)\b/);
            }
    });

    it("counts a gate only straight after the one before, and marks any other but the last", () => {
        const racer = fn("racer");
        for (let index = 0; index < boatRace.GATES.most; index += 1) {
            const counts = racer.find(
                (line) =>
                    line.endsWith("run function polaris:boat/pass") &&
                    line.includes(`if score @s pe_next matches ${index} `)
            )!;
            expect(counts).toContain(`if score #gates polaris_boat matches ${index + 1}..`);
            expect(counts).toContain(`if score #px polaris_boat >= #g${index}x1 polaris_boat`);
            const cut = racer.find(
                (line) =>
                    line.endsWith("run scoreboard players set @s pe_cut 1") &&
                    line.includes(`unless score @s pe_next matches ${index} `)
            )!;
            expect(cut).toContain(`unless score @s pe_last matches ${index} `);
            // Never before the start line: the grid may stand in the last gate.
            expect(cut).toContain("if score @s pe_gate matches 1..");
        }
        const pass = fn("pass");
        expect(pass[0]).toBe("scoreboard players add @s pe_gate 1");
        expect(pass[1]).toBe("scoreboard players operation @s pe_last = @s pe_next");
        expect(pass).toContain(
            "execute if score @s pe_next >= #gates polaris_boat run scoreboard players set @s pe_next 0"
        );
        expect(pass.at(-1)).toBe(
            "execute if score @s pe_gate >= #total polaris_boat store result score @s pe_fin run time query gametime"
        );
    });

    it("is armed for one track, switch last, and only that track's end switches it off", () => {
        const lines = boatRace.armLines(track);
        expect(lines).toContain(`scoreboard players set #gates polaris_boat ${track.gates.length}`);
        expect(lines).toContain(
            `scoreboard players set #total polaris_boat ${2 * track.gates.length + 1}`
        );
        const gate = track.gates[1]!;
        expect(lines).toContain(`scoreboard players set #g1x1 polaris_boat ${gate.x1 * 64}`);
        expect(lines).toContain(
            `scoreboard players set #g1z2 polaris_boat ${(gate.z2 + 1) * 64 - 1}`
        );
        expect(lines).toContain(
            `scoreboard players set #g1y1 polaris_boat ${(track.floor - 1) * 64}`
        );
        expect(lines.at(-1)).toBe("scoreboard players set #on polaris_boat 1");
        const stop = boatRace.stopLines(track.boxes);
        expect(stop).toHaveLength(1);
        expect(stop[0]).toMatch(
            /^execute if score #tx polaris_boat matches -?\d+ if score #tz polaris_boat matches -?\d+ run scoreboard players set #on polaris_boat 0$/
        );
        for (const part of stop[0]!.match(/#t[xz] polaris_boat matches -?\d+/g)!)
            expect(lines).toContain(`scoreboard players set ${part.replace(" matches ", " ")}`);
        expect(
            boatRace.stopLines(track.boxes.filter((box) => box.block !== "minecraft:blue_ice"))
        ).toEqual([]);
    });
});

describe("boats", () => {
    it("are summoned and ridden from 1.19.4, by the entity of each version, one racer at a time", () => {
        // Facing the track from the summon on - a turn sent after it is lost
        // on the racer's own game, which left them sitting across the track.
        expect(boatRace.boatLines("Ana", "oak_boat", -90)).toEqual([
            'execute as Ana at @s run summon minecraft:oak_boat ~ ~ ~ {Tags:["polaris_boat","polaris_boat_new"],Invulnerable:1b,Rotation:[-90.0f,0.0f]}',
            "execute as Ana at @s run ride @s mount @e[type=minecraft:oak_boat,tag=polaris_boat_new,limit=1,sort=nearest]",
            "tag @e[type=minecraft:oak_boat,tag=polaris_boat_new] remove polaris_boat_new"
        ]);
        expect(boatRace.boatLines("Ana", "oak_boat", 0).some((line) => line.includes(" tp "))).toBe(
            false
        );
        expect(boatRace.boatLines("Ana", "boat", 180)[0]).toBe(
            'execute as Ana at @s run summon minecraft:boat ~ ~ ~ {Tags:["polaris_boat","polaris_boat_new"],Invulnerable:1b,Rotation:[180.0f,0.0f],Type:"oak"}'
        );
        // Only for whoever looks within a range, when asked.
        expect(boatRace.boatLines("@a[tag=pe_mount]", "oak_boat", 90, "45..135")[0]).toBe(
            'execute as @a[tag=pe_mount,y_rotation=45..135] at @s run summon minecraft:oak_boat ~ ~ ~ {Tags:["polaris_boat","polaris_boat_new"],Invulnerable:1b,Rotation:[90.0f,0.0f]}'
        );
        // Before `ride`: a marked boat to put down.
        expect(boatRace.boatLines("Ana", "item", 0)).toEqual([
            "give Ana minecraft:oak_boat{polaris_event:1b} 1"
        ]);
    });

    it("splits the circle of facings between the spots' own, so every way a player looks is one spot's", () => {
        expect(boatRace.facingArcs([90, 90])).toEqual([{ yaw: 90, range: null }]);
        expect(boatRace.facingArcs([0, 90, 180, -90])).toEqual([
            { yaw: -180, range: "135..-135" },
            { yaw: -90, range: "-135..-45" },
            { yaw: 0, range: "-45..45" },
            { yaw: 90, range: "45..135" }
        ]);
        // Two facings: half the circle each, round either side.
        expect(boatRace.facingArcs([0, 90])).toEqual([
            { yaw: 0, range: "-135..45" },
            { yaw: 90, range: "45..-135" }
        ]);
    });

    it("are put back for whoever fell, cut a corner or left theirs, at the last gate they passed", () => {
        const track = trackOf("quick", 2);
        const told = { fell: '"fell"', cut: '"cut"', lost: '"lost"' };
        const lines = boatRace.quickLines(track, "oak_boat", told);
        // Who sits in which boat is asked of the boats (`execute on`), never
        // their saved data, which leaves a player out of `Passengers`: read
        // that way every boat with a racer in it was empty, was taken away,
        // and its racer put back in a new one, look after look.
        expect(lines.slice(0, 5)).toEqual([
            "tag @a[tag=pe_in,scores={pe_fin=0}] add pe_afoot",
            "execute in minecraft:overworld as @e[type=minecraft:oak_boat,tag=polaris_boat] on passengers run tag @s remove pe_afoot",
            "execute in minecraft:overworld as @e[type=minecraft:oak_boat,tag=polaris_boat] on passengers on vehicle run tag @s add pe_held",
            "execute in minecraft:overworld run kill @e[type=minecraft:oak_boat,tag=polaris_boat,tag=!pe_held]",
            "execute in minecraft:overworld run tag @e[type=minecraft:oak_boat,tag=pe_held] remove pe_held"
        ]);
        expect(lines.some((line) => line.includes("Passengers"))).toBe(false);
        expect(
            lines.some((line) => line.includes("pe_cut=1") && line.endsWith('tellraw @s "cut"'))
        ).toBe(true);
        expect(
            lines.some(
                (line) => line.includes("tag=pe_afoot") && line.endsWith('tellraw @s "lost"')
            )
        ).toBe(true);
        // Back to the start before the line, to each gate after.
        const start = boatRace.grid(track, 1)[0]!;
        expect(lines).toContain(
            `execute in minecraft:overworld run tp @a[tag=pe_reset,scores={pe_last=-1}] ${start.x.toFixed(3)} ${start.y.toFixed(3)} ${start.z.toFixed(3)} ${start.yaw.toFixed(1)} 0.0`
        );
        for (const [index, spot] of track.respawns.entries())
            expect(lines).toContain(
                `execute in minecraft:overworld run tp @a[tag=pe_reset,scores={pe_last=${index}}] ${spot.x.toFixed(3)} ${spot.y.toFixed(3)} ${spot.z.toFixed(3)} ${spot.yaw.toFixed(1)} 0.0`
            );
        // A boat each, one at a time.
        expect(lines.filter((line) => line.includes("run ride @s mount")).length).toBeGreaterThan(
            1
        );
        for (const line of lines.filter((one) => one.includes("run ride @s mount")))
            expect(line).toContain("execute as @a[tag=pe_mount]");
        // Each boat summoned facing the spot its racer was put back on: one
        // summon per facing the spots have, narrowed to the players turned
        // that way by the teleport.
        const arcs = boatRace.facingArcs([start, ...track.respawns].map((spot) => spot.yaw));
        for (const { yaw, range } of arcs)
            expect(lines).toContain(
                boatRace.boatLines("@a[tag=pe_mount]", "oak_boat", yaw, range)[0]!
            );
        expect(lines.some((line) => line.includes("rotated as @s run tp"))).toBe(false);
        expect(lines.at(-1)).toBe("tag @a remove pe_reset");
        // Before 1.19.4: nobody is put back for being out of a boat, only handed one.
        const old = boatRace.quickLines(track, "item", told);
        expect(old.some((line) => line.includes("pe_afoot") && line.includes("tellraw"))).toBe(
            false
        );
        expect(old.at(-1)).toBe(
            'give @a[tag=pe_in,scores={pe_fin=0},nbt=!{RootVehicle:{}},nbt=!{Inventory:[{id:"minecraft:oak_boat"}]}] minecraft:oak_boat{polaris_event:1b} 1'
        );
    });

    it("tells somebody past the boats one look has room for why only once, and seats them on the next", () => {
        const track = trackOf("crowd", 2);
        const told = { fell: '"fell"', cut: '"cut"', lost: '"lost"' };
        const lines = boatRace.quickLines(track, "oak_boat", told);
        // Whoever is still waiting for a boat from the last look is not told
        // they left theirs.
        const lost = lines.find((line) => line.endsWith('tellraw @s "lost"'))!;
        expect(lost).toContain("tag=!pe_reset,tag=!pe_bwait,");
        // Marked as waiting before the look's marks go, and the mark kept no
        // longer than the next look's check.
        expect(lines.at(-2)).toBe("tag @a[tag=pe_reset] add pe_bwait");
        expect(lines.indexOf("tag @a remove pe_bwait")).toBeGreaterThan(lines.indexOf(lost));
        expect(
            boatRace.quickLines(track, "item", told).some((line) => line.includes("pe_bwait"))
        ).toBe(false);
    });

    it("takes a racer back in a race they left from their last gate, with every pass they made", () => {
        const track = trackOf("back", 2);
        const gates = track.gates.length;
        expect(boatRace.racerScores("Ana")).toEqual([
            "scoreboard players set Ana pe_gate 0",
            "scoreboard players set Ana pe_next 0",
            "scoreboard players set Ana pe_last -1",
            "scoreboard players set Ana pe_fin 0",
            "scoreboard players set Ana pe_cut 0"
        ]);
        // The start line and two gates passed: the next is the third.
        expect(boatRace.racerScores("Ana", 3, gates).slice(0, 3)).toEqual([
            "scoreboard players set Ana pe_gate 3",
            "scoreboard players set Ana pe_next 3",
            "scoreboard players set Ana pe_last 2"
        ]);
        expect(boatRace.resumeSpot(track, 3)).toEqual(track.respawns[2]);
        // A whole lap and the line again: back to the line's own spot.
        expect(boatRace.racerScores("Ana", gates + 1, gates).slice(0, 3)).toEqual([
            `scoreboard players set Ana pe_gate ${gates + 1}`,
            "scoreboard players set Ana pe_next 1",
            "scoreboard players set Ana pe_last 0"
        ]);
        expect(boatRace.resumeSpot(track, gates + 1)).toEqual(track.respawns[0]);
        expect(boatRace.resumeSpot(track, 0)).toEqual(boatRace.grid(track, 1)[0]);
    });

    it("are all taken off the track at the end, under either name", () => {
        const track = trackOf("gone", 2);
        const lines = boatRace.boatsGone(track.volume);
        expect(lines.some((line) => line.includes("kill @e[type=minecraft:oak_boat,"))).toBe(true);
        expect(lines.some((line) => line.includes("kill @e[type=minecraft:boat,"))).toBe(true);
        expect(lines.at(-1)).toContain('nbt={Item:{id:"minecraft:oak_boat"}}');
    });
});

describe("what a boat race says", () => {
    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const) {
            const words = [
                said.readySubtitle(language),
                said.goSubtitle(5, language),
                said.bar(5, 5, 10, 10, language),
                said.fell(language),
                said.lost(language),
                said.cut(language),
                said.cannotPlay(language)
            ];
            for (const line of words) {
                expect(line).toMatch(/^&[0-9a-f]/);
                expect(
                    commandBytes(`tellraw Maximilian_1234 ${commands.text(line)}`)
                ).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            }
            expect(said.cut("en")).not.toBe(said.cut("es"));
        }
        const track = boatRace.track({ laps: 5 }, "far", { x: -29_999_000, z: 29_999_000 }, 300);
        const told = {
            fell: commands.text(said.fell("es")),
            cut: commands.text(said.cut("es")),
            lost: commands.text(said.lost("es"))
        };
        for (const way of ["oak_boat", "boat", "item", "item_components"] as const)
            for (const line of [
                ...boatRace.quickLines(track, way, told),
                ...boatRace.boatLines("Maximilian_1234", way, -180)
            ])
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        for (const line of [
            ...boatRace.armLines(track),
            ...boatRace.stopLines(track.boxes),
            ...boatRace.boatsGone(track.volume),
            ...boatRace.racerScores("Maximilian_1234")
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});
