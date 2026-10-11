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
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as hill from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hill";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const SITE = { x: -400, z: 250 };
const Y = 140;
/** A racer on their way home. */
const SAVED: stage.Saved = {
    name: "Ana",
    dimension: "minecraft:overworld",
    x: 0,
    y: 64,
    z: 0,
    yaw: 0,
    pitch: 0,
    mode: "survival"
};

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
        expect(elytra.stopLines([], "components")).toEqual([]);
        expect(elytra.isCourse(one.boxes)).toBe(true);
        expect(elytra.isCourse([{ block: "minecraft:packed_ice" }])).toBe(false);
    });

    it("puts back whoever fell or landed, and hands out owed rockets one a look", () => {
        const built = elytra.course({ laps: 2, obstacles: "few" }, "quick", SITE, Y);
        const lines = elytra.quickLines(built, "components", {
            fell: '"fell"',
            cut: '"cut"',
            howTo: '"how"'
        });
        expect(lines.some((line) => line.includes("nbt={OnGround:1b}"))).toBe(true);
        // Never read as landed again before the server has seen them off the
        // ground since they were put back: the loop that kicked racers for
        // flying.
        for (const line of lines.filter((one) => one.includes("nbt={OnGround:1b}"))) {
            expect(line).toContain(`tag=!${elytra.SENT_TAG}`);
        }
        const sent = lines.indexOf(`tag @a[tag=pe_ereset] add ${elytra.SENT_TAG}`);
        const cleared = lines.indexOf(
            `tag @a[tag=${elytra.SENT_TAG},nbt={OnGround:0b}] remove ${elytra.SENT_TAG}`
        );
        expect(cleared).toBeGreaterThanOrEqual(0);
        expect(sent).toBeGreaterThan(
            lines.findLastIndex((line) => line.includes(" run tp @a[tag=pe_ereset,"))
        );
        expect(elytra.racerScores("Steve")).toContain(`tag Steve remove ${elytra.SENT_TAG}`);
        expect(
            lines.some((line) => line.includes("dy=") && line.includes('tellraw @s "fell"'))
        ).toBe(true);
        expect(lines.filter((line) => line.includes(" run tp @a[tag=pe_ereset,"))).toHaveLength(
            built.rings.length + 1
        );
        // The rockets they are owed go into the hand they hold, one each look;
        // then whoever is out of the race and still holds its kit loses it.
        const owed = "@a[tag=pe_in,scores={pe_erkt=1..}]";
        const handed = lines.indexOf(elytra.rocketLines(owed, "components", 1)[0]!);
        expect(lines.slice(handed, handed + 3)).toEqual([
            ...elytra.rocketLines(owed, "components", 1),
            `scoreboard players remove ${owed} pe_erkt 1`
        ]);
        expect(lines.slice(-2)).toEqual(elytra.kitGoneLines("@a[tag=!pe_in]", "components"));
        expect(
            elytra
                .quickLines(built, null, { fell: "1", cut: "2", howTo: "3" })
                .some((line) => line.includes("firework_rocket"))
        ).toBe(false);
    });
});

describe("a racer who has not found their wings", () => {
    const built = elytra.course({ laps: 2, obstacles: "few" }, "learner", SITE, Y);
    const lines = elytra.quickLines(built, null, { fell: '"fell"', cut: '"cut"', howTo: '"how"' });
    const at = (part: string) => lines.findIndex((line) => line.includes(part));

    it("has a grace after each put-back before a fall or a landing counts", () => {
        const put = lines.filter(
            (line) => line.includes("add pe_ereset") && !line.includes("pe_ecut=1")
        );
        expect(put).toHaveLength(2);
        for (const line of put) expect(line).toContain(`${elytra.GRACE_SCORE}=..0`);
        expect(lines).toContain(
            `scoreboard players set @a[tag=pe_ereset] ${elytra.GRACE_SCORE} ${elytra.GRACE_LOOKS}`
        );
        // Counted down once a look, before it is read.
        const down = lines.indexOf(
            `scoreboard players remove @a[tag=pe_in,scores={${elytra.GRACE_SCORE}=1..}] ${elytra.GRACE_SCORE} 1`
        );
        expect(down).toBeGreaterThanOrEqual(0);
        expect(down).toBeLessThan(at("add pe_ereset"));
        // Short of the 80 ticks (4 s) the server's floating check counts.
        expect(elytra.GRACE_LOOKS * 0.4).toBeLessThan(4);
    });

    it("makes its own counts in a race armed before they existed", () => {
        for (const name of [elytra.GRACE_SCORE, elytra.TRIES_SCORE, "pe_eseen"]) {
            const made = lines.indexOf(`scoreboard objectives add ${name} dummy`);
            expect(made).toBeGreaterThanOrEqual(0);
            const used = lines.findIndex(
                (line) => line.includes(name) && !line.startsWith("scoreboard objectives")
            );
            expect(made).toBeLessThan(used);
        }
    });

    it("is told how to fly after a few tries, and then left standing where they land", () => {
        const landed = lines.find((line) => line.includes("nbt={OnGround:1b}] add pe_ereset"))!;
        expect(landed).toContain(`${elytra.TRIES_SCORE}=..${elytra.TRIES_MOST - 1}`);
        const fell = lines.find((line) => line.includes(",dy=") && line.includes("add pe_ereset"))!;
        expect(fell).not.toContain(elytra.TRIES_SCORE);
        const counted = lines.indexOf(
            `scoreboard players add @a[tag=pe_ereset] ${elytra.TRIES_SCORE} 1`
        );
        const told = lines.indexOf(
            `execute as @a[tag=pe_ereset,scores={${elytra.TRIES_SCORE}=${elytra.TRIES_MOST}..}] run tellraw @s "how"`
        );
        expect(counted).toBeGreaterThan(at("nbt={OnGround:1b}] add pe_ereset"));
        expect(told).toBeGreaterThan(counted);
        expect(told).toBeLessThan(at(" run tp @a[tag=pe_ereset,"));
        for (const language of ["en", "es"] as const)
            expect(said.howToFly(language).length).toBeGreaterThan(20);
        expect(said.howToFly("es")).not.toBe(said.howToFly("en"));
    });

    it("starts their tries over at every ring they pass", () => {
        const reset = lines.indexOf(
            `execute as @a[tag=pe_in] if score @s ${elytra.PASSED_SCORE} > @s pe_eseen run scoreboard players set @s ${elytra.TRIES_SCORE} 0`
        );
        const seen = lines.indexOf(
            `execute as @a[tag=pe_in] run scoreboard players operation @s pe_eseen = @s ${elytra.PASSED_SCORE}`
        );
        expect(reset).toBeGreaterThanOrEqual(0);
        expect(seen).toBe(reset + 1);
        expect(elytra.racerScores("Steve")).toEqual(
            expect.arrayContaining([
                `scoreboard players set Steve ${elytra.GRACE_SCORE} 0`,
                `scoreboard players set Steve ${elytra.TRIES_SCORE} 0`
            ])
        );
        for (const name of [elytra.GRACE_SCORE, elytra.TRIES_SCORE, "pe_eseen"])
            expect(elytra.SCORES_REMOVED).toContain(`scoreboard objectives remove ${name}`);
    });

    it("is lifted a moment at each put-back, which the floating check never counts", () => {
        const lift = lines.indexOf("effect give @a[tag=pe_ereset] minecraft:levitation 1 0 true");
        expect(lift).toBeGreaterThan(
            lines.findLastIndex((line) => line.includes(" run tp @a[tag=pe_ereset,"))
        );
        expect(lift).toBeLessThan(lines.indexOf("tag @a remove pe_ereset"));
        expect(lines.some((line) => line.includes("slow_falling"))).toBe(false);
    });

    it("is put back over open air down to the fall line, over thousands of runs", () => {
        const sameBox = (a: stage.Volume, b: stage.Volume) =>
            a.x1 === b.x1 &&
            a.y1 === b.y1 &&
            a.z1 === b.z1 &&
            a.x2 === b.x2 &&
            a.y2 === b.y2 &&
            a.z2 === b.z2;
        const problems: string[] = [];
        for (const obstacles of catalog.ELYTRA_OBSTACLES)
            for (let seed = 0; seed < 600; seed += 1) {
                const one = elytra.course({ laps: 2, obstacles }, `air-${seed}`, SITE, Y);
                // The pad is taken away at the go (`padGone`).
                const boxes = one.boxes.filter((box) => !sameBox(box, one.pad));
                for (const spot of [one.start, ...one.respawns])
                    for (const box of boxes) {
                        const x = Math.floor(spot.x);
                        const z = Math.floor(spot.z);
                        const inX = x >= Math.min(box.x1, box.x2) && x <= Math.max(box.x1, box.x2);
                        const inZ = z >= Math.min(box.z1, box.z2) && z <= Math.max(box.z1, box.z2);
                        const top = Math.max(box.y1, box.y2);
                        if (inX && inZ && top < Math.floor(spot.y) && top > one.fallY)
                            problems.push(`${obstacles} ${seed}: ${box.block} under a restart`);
                    }
            }
        expect(problems.slice(0, 5)).toEqual([]);
    }, 180_000);
});

describe("Slow Falling in an event", () => {
    it("is never given to a player: the floating check kicks whoever it holds up", () => {
        const volume = { x1: 0, y1: 100, z1: 0, x2: 10, y2: 110, z2: 10 };
        const given = [
            ...stage.fallProof("@a[tag=pe_in]"),
            ...stage.fallProofOver(volume),
            stage.floatDown(volume, 5),
            arena.floatDown("Ana"),
            hill.catchLine({ x: 0, y: 100, z: 0 }, 8)
        ];
        for (const line of given.filter((one) => one.includes("slow_falling")))
            expect(line).toContain("@e[type=!player,");
        expect(stage.fallProof("Ana")).toEqual([
            "effect give Ana minecraft:resistance 10 4 true",
            `effect give Ana minecraft:fire_resistance ${stage.BURN_SECONDS} 0 true`
        ]);
        expect(arena.floatDown("Ana")).toBe("effect give Ana minecraft:resistance 3 4 true");
    });
});

describe("what an elytra race hands out and says", () => {
    it("gives a marked elytra worn, and marked rockets, in both item syntaxes", () => {
        expect(elytra.elytraLine("Ana", "components")).toBe(
            "item replace entity Ana armor.chest with minecraft:elytra[minecraft:custom_data={polaris_event:1b},minecraft:unbreakable={}] 1"
        );
        expect(elytra.elytraLine("Ana", "nbt")).toContain("{polaris_event:1b,Unbreakable:1b}");
        expect(elytra.rocketLines("Ana", "nbt", 3)[0]).toContain(
            "firework_rocket{polaris_event:1b,Fireworks:{Flight:1b}} 3"
        );
        expect(elytra.rocketLines("Ana", "components", 3)[0]).toContain(
            "minecraft:firework_rocket[minecraft:custom_data={polaris_event:1b},minecraft:fireworks={flight_duration:1}] 3"
        );
        expect(stage.clearMarked("Ana", "nbt")).toEqual(
            expect.arrayContaining([
                "clear Ana minecraft:elytra{polaris_event:1b}",
                "clear Ana minecraft:firework_rocket{polaris_event:1b}"
            ])
        );
    });

    it("puts the rockets in the hand the racer holds, never in some other slot", () => {
        // In the selected slot while it is empty; with a plain give they went
        // to the first free slot, and a racer gliding with an empty hand
        // right-clicked to no effect. Otherwise given, which tops up the
        // rockets already held. Exactly one of the two lines ever runs: the
        // give first, so a hand just filled is not given to again.
        const rocket =
            "minecraft:firework_rocket[minecraft:custom_data={polaris_event:1b},minecraft:fireworks={flight_duration:1}]";
        expect(elytra.flyLines("Ana", "components")).toEqual([
            "item replace entity Ana armor.chest with minecraft:elytra[minecraft:custom_data={polaris_event:1b},minecraft:unbreakable={}] 1",
            `execute as Ana if items entity @s weapon.mainhand * run give @s ${rocket} ${elytra.START_ROCKETS}`,
            `execute as Ana unless items entity @s weapon.mainhand * run item replace entity @s weapon.mainhand with ${rocket} ${elytra.START_ROCKETS}`
        ]);
        // Before 1.20.5 there is no `if items`: a held stack is `SelectedItem`.
        expect(elytra.rocketLines("Ana", "nbt", 2)).toEqual([
            "execute as Ana if data entity @s SelectedItem run give @s minecraft:firework_rocket{polaris_event:1b,Fireworks:{Flight:1b}} 2",
            "execute as Ana unless data entity @s SelectedItem run item replace entity @s weapon.mainhand with minecraft:firework_rocket{polaris_event:1b,Fireworks:{Flight:1b}} 2"
        ]);
        // Rockets are never handed out with a bare give again.
        for (const line of [
            ...elytra.flyLines("Ana", "components"),
            ...elytra.flyLines("Ana", "nbt")
        ])
            expect(line.startsWith("give ")).toBe(false);
    });

    it("takes the kit back - the worn elytra too - from whoever is out of the race", () => {
        // On the way home: the marked wildcard reaches the chest slot as well
        // as the bag, before the tag that marks them as in is taken off.
        expect(stage.clearMarked("Ana", "components")).toEqual([
            "clear Ana *[minecraft:custom_data={polaris_event:1b}]"
        ]);
        const home = stage.afterReturnLines(SAVED, "components", '"back"');
        expect(home.indexOf("clear Ana *[minecraft:custom_data={polaris_event:1b}]")).toBe(0);
        expect(home.indexOf("tag Ana remove pe_in")).toBeGreaterThan(0);
        // And from anybody outside the race who still holds it, whatever way
        // they got out with it: every quick look, and at the teardown.
        expect(elytra.kitGoneLines(elytra.OUTSIDE, "components")).toEqual([
            "clear @a[tag=!pe_in] minecraft:elytra[minecraft:custom_data={polaris_event:1b}]",
            "clear @a[tag=!pe_in] minecraft:firework_rocket[minecraft:custom_data={polaris_event:1b}]"
        ]);
        expect(elytra.kitGoneLines(elytra.OUTSIDE, "nbt")).toEqual([
            "clear @a[tag=!pe_in] minecraft:elytra{polaris_event:1b}",
            "clear @a[tag=!pe_in] minecraft:firework_rocket{polaris_event:1b}"
        ]);
        const built = elytra.course({ laps: 2, obstacles: "few" }, "kit", SITE, Y);
        expect(elytra.stopLines(built.boxes, "components").slice(-2)).toEqual(
            elytra.kitGoneLines(elytra.OUTSIDE, "components")
        );
        expect(elytra.stopLines(built.boxes)).toHaveLength(2);
    });

    it("tells a racer put back to open their wings again", () => {
        // The lift that holds them up after a put-back closes the wings, and a
        // rocket does nothing until they are open again.
        expect(said.fell("en")).toContain("Press jump to open your elytra again.");
        expect(said.cut("en")).toContain("Press jump to open your elytra again.");
        expect(said.fell("es")).toContain("Pulsa saltar para abrir los élitros otra vez.");
        expect(said.cut("es")).toContain("Pulsa saltar para abrir los élitros otra vez.");
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
            ...elytra.stopLines(built.boxes, "components"),
            ...elytra.quickLines(built, "components", { fell: '"x"', cut: '"y"', howTo: '"z"' }),
            elytra.padGone(built)
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});
