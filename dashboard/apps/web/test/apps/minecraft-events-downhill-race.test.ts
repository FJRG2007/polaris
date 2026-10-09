/**
 * The downhill boat race (`kinds/downhill-race`): its road checked against its
 * rules over thousands of runs - from the blocks it is built of - and the
 * boat race's pack and quick look armed for a road that runs one way, down.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as boatRace from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/boat-race";
import * as downhill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/downhill-race";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/downhill-race-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const SITE = { x: 300, z: -120 };
const Y = 90;
const ICE = new Set(["minecraft:packed_ice", "minecraft:blue_ice"]);
const WALLS = new Set([
    "minecraft:white_concrete",
    "minecraft:sea_lantern",
    "minecraft:light_blue_stained_glass"
]);

/** Every block the boxes put down, by `x,y,z`; one put twice is a problem. */
function blocksOf(boxes: readonly stage.Box[], problems: string[]): Map<string, string> {
    const blocks = new Map<string, string>();
    for (const box of boxes)
        for (let x = box.x1; x <= box.x2; x += 1)
            for (let y = box.y1; y <= box.y2; y += 1)
                for (let z = box.z1; z <= box.z2; z += 1) {
                    const at = `${x},${y},${z}`;
                    if (blocks.has(at)) problems.push(`${at} put twice`);
                    blocks.set(at, box.block);
                }
    return blocks;
}

describe("a downhill race's road", () => {
    it("keeps every rule over thousands of runs, at either slope, from the blocks it is built of", () => {
        const problems: string[] = [];
        let runs = 0;
        for (const steepness of catalog.DOWNHILL_STEEPNESS)
            for (let seed = 0; seed < 600; seed += 1) {
                runs += 1;
                const fail = (what: string) => problems.push(`${steepness} ${seed}: ${what}`);
                const track = downhill.course({ steepness }, `run-${seed}`, SITE, Y);
                for (const one of downhill.courseProblems(track.layout, steepness)) fail(one);
                const blocks = blocksOf(track.boxes, problems);
                for (const box of track.boxes) {
                    if (!(stage.ARENA_BLOCKS as readonly string[]).includes(box.block))
                        fail(`not an arena block: ${box.block}`);
                    if (stage.volumeOf(box) > stage.FILL_LIMIT) fail("box too big for one fill");
                    const v = track.volume;
                    if (
                        box.x1 < v.x1 ||
                        box.x2 > v.x2 ||
                        box.y1 < v.y1 ||
                        box.y2 > v.y2 ||
                        box.z1 < v.z1 ||
                        box.z2 > v.z2
                    )
                        fail(`${box.block} outside the volume`);
                }
                // The ice, column by column: one block of it, the top down to the
                // bottom, with walls two over it wherever the road ends.
                const ice = new Map<string, number>();
                for (const [at, block] of blocks) {
                    if (!ICE.has(block)) continue;
                    const [x, y, z] = at.split(",").map(Number) as [number, number, number];
                    if (ice.has(`${x},${z}`)) fail(`two ice blocks at ${x},${z}`);
                    ice.set(`${x},${z}`, y);
                }
                const heights = [...ice.values()];
                if (Math.max(...heights) !== track.floor) fail("the top is not the floor");
                if (Math.min(...heights) !== track.downhill!.bottom) fail("the bottom is off");
                for (const [at, y] of ice) {
                    const [x, z] = at.split(",").map(Number) as [number, number];
                    for (let dx = -1; dx <= 1; dx += 1)
                        for (let dz = -1; dz <= 1; dz += 1) {
                            const near = `${x + dx},${z + dz}`;
                            const other = ice.get(near);
                            if (other !== undefined) {
                                if (Math.abs(other - y) > 1) fail(`a step of two at ${near}`);
                                continue;
                            }
                            // Beside the road: wall from the ice up two over it.
                            for (let up = 0; up <= 2; up += 1)
                                if (!WALLS.has(blocks.get(`${x + dx},${y + up},${z + dz}`) ?? ""))
                                    fail(`a gap in the wall by ${at} at +${up}`);
                        }
                    // Room over the ice for a boat and its racer.
                    for (const up of [1, 2])
                        if (blocks.has(`${x},${y + up},${z}`)) fail(`no room over ${at}`);
                }
                // The start grid on the top, level, however many race - past the
                // rows it has room for, never off the end of the road; every
                // gate's restart on its ice.
                for (const spot of boatRace.grid(track, 45)) {
                    const at = `${Math.floor(spot.x)},${Math.floor(spot.z)}`;
                    if (ice.get(at) !== track.floor) fail(`grid spot off the top at ${at}`);
                    if (spot.y !== track.floor + 1) fail("grid spot not on the ice");
                }
                track.respawns.forEach((spot, index) => {
                    const at = `${Math.floor(spot.x)},${Math.floor(spot.z)}`;
                    if (ice.get(at) !== spot.y - 1) fail(`restart ${index} not on its ice`);
                    if (spot.y - 1 !== track.downhill!.gateFloors[index])
                        fail(`gate ${index} at the wrong height`);
                });
                // Down, gate after gate: the finish lowest, well under the start.
                const floors = track.downhill!.gateFloors;
                floors.forEach((one, index) => {
                    if (index > 0 && one > floors[index - 1]!) fail(`gate ${index} higher`);
                });
                // The finish line's ice is taken a few blocks before it, so it can be
                // the block over the last drop.
                if (floors.at(-1)! - track.downhill!.bottom > 1) fail("finish not at the bottom");
                if (track.floor - track.downhill!.bottom < 20) fail("hardly downhill");
                if (track.gates.length < 3) fail("no checkpoint");
                if (track.gates.length > boatRace.GATES.most)
                    fail("more lines than the pack counts");
            }
        expect(runs).toBe(1200);
        expect(problems.slice(0, 5)).toEqual([]);
    }, 300_000);

    it("lays out the same road for the same run, steeper when asked", () => {
        const one = downhill.course({ steepness: "gentle" }, "same", SITE, Y);
        expect(downhill.course({ steepness: "gentle" }, "same", SITE, Y)).toEqual(one);
        const steep = downhill.course({ steepness: "steep" }, "same", SITE, Y);
        expect(steep.floor - Y).toBeGreaterThan(one.floor - Y);
        expect(steep.layout).toBe(one.layout);
    });
});

describe("the boat race's pack and quick look, downhill", () => {
    const track = downhill.course({ steepness: "steep" }, "pack", SITE, Y);

    it("is raced once: every line passed once makes the finish, each gate at its own height", () => {
        expect(boatRace.passesOf(track)).toBe(track.gates.length);
        const arm = boatRace.armLines(track);
        expect(arm).toContain(`scoreboard players set #total polaris_boat ${track.gates.length}`);
        track.downhill!.gateFloors.forEach((floor, index) => {
            expect(arm).toContain(
                `scoreboard players set #g${index}y1 polaris_boat ${(floor - 1) * 64}`
            );
            expect(arm).toContain(
                `scoreboard players set #g${index}y2 polaris_boat ${(floor + 4) * 64 - 1}`
            );
        });
        expect(arm.at(-1)).toBe("scoreboard players set #on polaris_boat 1");
        // A loop is still laps of gates and the start line once more.
        const loop = boatRace.track({ laps: 2 }, "pack", SITE, Y);
        expect(boatRace.passesOf(loop)).toBe(2 * loop.gates.length + 1);
    });

    it("counts a fall from under the bottom of the road, not under the top", () => {
        const lines = boatRace.quickLines(track, "oak_boat", {
            fell: '"f"',
            cut: '"c"',
            lost: '"l"'
        });
        const fell = lines.find((line) => line.includes('tellraw @s "f"'))!;
        const dy = Number(/dy=(\d+)/.exec(fell)![1]);
        const y = Number(/,y=(-?\d+),/.exec(fell)![1]);
        expect(y + dy).toBe(track.downhill!.bottom - 1);
        for (const line of lines) expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });

    it("says its own lines in both languages, and is a boat race to the cleanup", () => {
        for (const language of ["en", "es"] as const)
            for (const line of [
                said.readySubtitle(language),
                said.goSubtitle(language),
                said.bar(2, 5, language),
                said.cannotPlay(language)
            ])
                expect(line.length).toBeGreaterThan(5);
        expect(said.bar(2, 5, "es")).not.toBe(said.bar(2, 5, "en"));
        expect(boatRace.isTrack(track.boxes)).toBe(true);
        expect(boatRace.stopLines(track.boxes)).toHaveLength(1);
        for (const box of track.boxes)
            expect(commandBytes(stage.buildLine(box))).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});
