/**
 * The elytra race (`kinds/elytra-race`): its course checked against its rules
 * over thousands of runs, a flight along the line from ring to ring over the
 * blocks it is built of, and the data pack that counts its rings.
 */

import { describe, expect, it } from "vitest";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as elytra from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/elytra-race";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/elytra-race-messages";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const SITE = { x: -400, z: 250 };
const Y = 140;

/** Every block the boxes put down, by `x,y,z`; a block put twice is a problem. */
function blocksOf(boxes: readonly stage.Box[], problems: string[]): Map<string, string> {
    const blocks = new Map<string, string>();
    for (const box of boxes)
        for (let x = Math.min(box.x1, box.x2); x <= Math.max(box.x1, box.x2); x += 1)
            for (let y = Math.min(box.y1, box.y2); y <= Math.max(box.y1, box.y2); y += 1)
                for (let z = Math.min(box.z1, box.z2); z <= Math.max(box.z1, box.z2); z += 1) {
                    const at = `${x},${y},${z}`;
                    if (blocks.has(at)) problems.push(`${at} put twice`);
                    blocks.set(at, box.block);
                }
    return blocks;
}

/** A flight from ring to ring along the straight line between their centres,
 *  a body's width round it: answers every block it would touch. */
function flown(built: elytra.Course, blocks: ReadonlyMap<string, string>): string[] {
    const hit: string[] = [];
    const count = built.rings.length;
    built.rings.forEach((one, index) => {
        const next = built.rings[(index + 1) % count]!;
        const a = { x: one.center.x + 0.5, y: one.center.y + 0.5, z: one.center.z + 0.5 };
        const b = { x: next.center.x + 0.5, y: next.center.y + 0.5, z: next.center.z + 0.5 };
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 4);
        for (let at = 0; at <= steps; at += 1) {
            const t = at / steps;
            const p = {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t
            };
            for (const dx of [-0.3, 0.3])
                for (const dy of [-0.3, 0.3])
                    for (const dz of [-0.3, 0.3]) {
                        const key = `${Math.floor(p.x + dx)},${Math.floor(p.y + dy)},${Math.floor(p.z + dz)}`;
                        const block = blocks.get(key);
                        if (block) hit.push(`${block} at ${key} after ring ${index}`);
                    }
        }
    });
    return hit;
}

describe("an elytra race's course", () => {
    it("keeps every rule over thousands of runs, with every number of obstacles", () => {
        const problems: string[] = [];
        let pillars = 0;
        for (const obstacles of catalog.ELYTRA_OBSTACLES)
            for (let seed = 0; seed < 600; seed += 1) {
                const built = elytra.course({ laps: 2, obstacles }, `run-${seed}`, SITE, Y);
                const fail = (what: string) => problems.push(`${obstacles} ${seed}: ${what}`);
                for (const one of elytra.courseProblems(built)) fail(one);
                const blocks = blocksOf(built.boxes, problems);
                for (const box of built.boxes) {
                    if (!(stage.ARENA_BLOCKS as readonly string[]).includes(box.block))
                        fail(`not an arena block: ${box.block}`);
                    if (stage.volumeOf(box) > 32_768) fail("box too big for one fill");
                }
                for (const one of flown(built, blocks)) fail(one);
                if (built.rings.length < 4) fail("too few rings");
                if (built.boosters.length !== built.rings.length) fail("a leg with no booster");
                if (built.respawns.length !== built.rings.length)
                    fail("a ring with nowhere to restart");
                // Every racer starts on the pad, over the start ring, behind it.
                for (const spot of elytra.spots(built, 12)) {
                    if (!elytra.onPad(built, spot)) fail("starts off the pad");
                    if (spot.y <= built.rings[0]!.center.y) fail("starts below the start ring");
                }
                // A restart is in the open, above the fall line, inside.
                for (const spot of [built.start, ...built.respawns]) {
                    const key = `${Math.floor(spot.x)},${Math.floor(spot.y)},${Math.floor(spot.z)}`;
                    if (blocks.has(key)) fail(`restarts inside ${blocks.get(key)}`);
                    if (spot.y <= built.fallY) fail("restarts below the fall line");
                }
                pillars += built.pillars.length;
            }
        expect(problems.slice(0, 5)).toEqual([]);
        expect(pillars).toBeGreaterThan(1000);
    }, 180_000);

    it("lays out the same course for the same run, and another for another", () => {
        const one = elytra.course({ laps: 2, obstacles: "few" }, "a", SITE, Y);
        expect(elytra.course({ laps: 2, obstacles: "few" }, "a", SITE, Y)).toEqual(one);
        expect(elytra.course({ laps: 2, obstacles: "few" }, "b", SITE, Y).boxes).not.toEqual(
            one.boxes
        );
        expect(elytra.course({ laps: 2, obstacles: "none" }, "a", SITE, Y).pillars).toEqual([]);
    });

    it("counts a racer's progress lap by lap, and restarts them behind their last ring", () => {
        const built = elytra.course({ laps: 3, obstacles: "few" }, "laps", SITE, Y);
        const rings = built.rings.length;
        expect(elytra.progressOf(built, 0)).toEqual({ lap: 1, ring: 0 });
        expect(elytra.progressOf(built, rings + 2)).toEqual({ lap: 2, ring: 1 });
        expect(elytra.resumeSpot(built, 0)).toEqual(built.start);
        expect(elytra.resumeSpot(built, rings + 1)).toEqual(built.respawns[0]);
        expect(elytra.nextRing(built, 1)).toBe(built.rings[1]);
    });
});

describe("the elytra race's data pack", () => {
    const files = snowballPack.packFiles();
    const fn = (name: string) =>
        files.get(`data/polaris/function/elytra/${name}.mcfunction`)!.trimEnd().split("\n");

    it("is part of the events pack, in both spellings of the function folders", () => {
        for (const folder of ["functions", "function"])
            expect(files.has(`data/polaris/${folder}/elytra/tick.mcfunction`)).toBe(true);
        expect(files.get("data/minecraft/tags/function/tick.json")).toContain(
            "polaris:elytra/tick"
        );
    });

    it("counts the next ring, owes a rocket for it and for a booster, and marks one out of turn", () => {
        expect(fn("tick")[0]).toContain("scores={pe_efin=0}");
        const racer = fn("racer").join("\n");
        expect(racer).toContain("if score @s pe_enext matches 0");
        expect(racer).toContain("run scoreboard players set @s pe_ecut 1");
        expect(racer).toContain(`run scoreboard players add @s pe_erkt ${elytra.BOOST_ROCKETS}`);
        expect(fn("pass")).toContain(`scoreboard players add @s pe_erkt ${elytra.RING_ROCKETS}`);
        expect(fn("pass").at(-1)).toContain("time query gametime");
    });

    it("is armed for one course, switch last, and only that course's end switches it off", () => {
        const one = elytra.course({ laps: 2, obstacles: "few" }, "arm", SITE, Y);
        const other = elytra.course({ laps: 2, obstacles: "few" }, "arm", { x: 900, z: 900 }, Y);
        const arm = elytra.armLines(one);
        expect(arm.at(-1)).toBe("scoreboard players set #on polaris_elytra 1");
        expect(arm).toContain(
            `scoreboard players set #total polaris_elytra ${2 * one.rings.length + 1}`
        );
        expect(elytra.stopLines(one.boxes)[0]).not.toEqual(elytra.stopLines(other.boxes)[0]);
        expect(elytra.stopLines(one.boxes)[1]).toContain("kill @e[type=minecraft:firework_rocket,");
        expect(elytra.stopLines([])).toEqual([]);
        expect(elytra.isCourse(one.boxes)).toBe(true);
        expect(elytra.isCourse([{ block: "minecraft:packed_ice" }])).toBe(false);
    });

    it("puts back whoever fell or landed, and hands out owed rockets one a look", () => {
        const built = elytra.course({ laps: 2, obstacles: "few" }, "quick", SITE, Y);
        const lines = elytra.quickLines(built, "components", { fell: '"fell"', cut: '"cut"' });
        expect(lines.some((line) => line.includes("nbt={OnGround:1b}"))).toBe(true);
        expect(
            lines.some((line) => line.includes("dy=") && line.includes('tellraw @s "fell"'))
        ).toBe(true);
        expect(lines.filter((line) => line.includes(" run tp @a[tag=pe_ereset,"))).toHaveLength(
            built.rings.length + 1
        );
        expect(lines.at(-2)).toContain(
            "give @a[tag=pe_in,scores={pe_erkt=1..}] minecraft:firework_rocket["
        );
        expect(
            elytra
                .quickLines(built, null, { fell: "1", cut: "2" })
                .some((line) => line.includes("give"))
        ).toBe(false);
    });
});

describe("what an elytra race hands out and says", () => {
    it("gives a marked elytra worn, and marked rockets, in both item syntaxes", () => {
        expect(elytra.elytraLine("Ana", "components")).toBe(
            "item replace entity Ana armor.chest with minecraft:elytra[minecraft:custom_data={polaris_event:1b},minecraft:unbreakable={}] 1"
        );
        expect(elytra.elytraLine("Ana", "nbt")).toContain("{polaris_event:1b,Unbreakable:1b}");
        expect(elytra.rocketLine("Ana", "nbt", 3)).toContain("firework_rocket{polaris_event:1b,");
        expect(stage.clearMarked("Ana", "nbt")).toEqual(
            expect.arrayContaining([
                "clear Ana minecraft:elytra{polaris_event:1b}",
                "clear Ana minecraft:firework_rocket{polaris_event:1b}"
            ])
        );
    });

    it("needs 1.17, to put the elytra on", () => {
        const preset = catalog.newPreset("elytra-race", "wings");
        expect(catalog.incompatibility(preset, "1.16.5")).toEqual({ why: "arena", needs: "1.17" });
        expect(catalog.incompatibility(preset, "1.21.4")).toBeNull();
    });

    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const)
            for (const line of [
                said.readySubtitle(language),
                said.goSubtitle(language),
                said.bar(1, 2, 3, 6, 120, 4, language),
                said.fell(language),
                said.cut(language),
                said.cannotPlay(language)
            ])
                expect(line.length).toBeGreaterThan(5);
        expect(said.fell("es")).not.toBe(said.fell("en"));
        const built = elytra.course({ laps: 3, obstacles: "many" }, "size", SITE, Y);
        for (const line of [
            ...built.boxes.map(stage.buildLine),
            ...elytra.armLines(built),
            ...elytra.stopLines(built.boxes),
            ...elytra.quickLines(built, "components", { fell: '"x"', cut: '"y"' }),
            elytra.padGone(built)
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});
