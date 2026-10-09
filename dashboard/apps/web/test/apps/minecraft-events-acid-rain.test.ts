/**
 * Acid rain (`kinds/acid-rain`): its arena checked against its rules over
 * thousands of runs, who the data pack takes for out in the rain over the
 * blocks the arena is built of, what the rain eats and what it leaves, and that
 * the world's weather is never touched.
 */

import { describe, expect, it } from "vitest";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as acid from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/acid-rain";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/acid-rain-messages";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const SIZES = catalog.ACID_SIZES;
const ACIDITIES = catalog.ACIDITIES;
const SITE = { x: 100, z: -200 };
const Y = 120;

/** Every block the boxes put down, by `x,y,z`; a block put twice throws. */
function blocksOf(boxes: readonly stage.Box[]): Map<string, string> {
    const blocks = new Map<string, string>();
    for (const box of boxes)
        for (let x = Math.min(box.x1, box.x2); x <= Math.max(box.x1, box.x2); x += 1)
            for (let y = Math.min(box.y1, box.y2); y <= Math.max(box.y1, box.y2); y += 1)
                for (let z = Math.min(box.z1, box.z2); z <= Math.max(box.z1, box.z2); z += 1) {
                    const at = `${x},${y},${z}`;
                    if (blocks.has(at)) throw new Error(`${at} put twice`);
                    blocks.set(at, box.block);
                }
    return blocks;
}

/**
 * Whether the pack's `expose` takes a player standing on the block `x,y,z`
 * (feet at `y`) for out in the rain: read from its own lines, every offset it
 * looks at, any block there but air and the roof's barrier counting as cover.
 */
const LOOKED_AT = [
    ...snowballPack
        .packFiles()
        .get("data/polaris/function/acid/expose.mcfunction")!
        .matchAll(/unless block ~ ~(\d+) ~ minecraft:air/g)
].map((match) => Number(match[1]));

function wet(blocks: ReadonlyMap<string, string>, x: number, y: number, z: number): boolean {
    return LOOKED_AT.every((up) => {
        const block = blocks.get(`${x},${y + up},${z}`) ?? "minecraft:air";
        return block === "minecraft:air" || block === "minecraft:barrier";
    });
}

describe("an acid rain's arena", () => {
    it("looks for cover from over a player's head to past the roof", () => {
        expect(LOOKED_AT[0]).toBe(2);
        expect(Math.max(...LOOKED_AT)).toBeGreaterThan(acid.ROOF);
    });

    it("keeps every rule over thousands of runs, every size and acidity", () => {
        const problems: string[] = [];
        let runs = 0;
        for (const size of SIZES)
            for (const acidity of ACIDITIES)
                for (let seed = 0; seed < 500; seed += 1) {
                    const built = acid.arena({ size, acidity }, `run-${seed}`, SITE, Y);
                    const half = acid.HALF[size];
                    const fail = (what: string) =>
                        problems.push(`${size} ${acidity} ${seed}: ${what}`);
                    // Every hut there was room for, inside the walls, apart.
                    if (built.huts.length !== acid.HUTS[size]) fail("huts missing");
                    for (const hut of built.huts) {
                        if (Math.max(Math.abs(hut.x), Math.abs(hut.z)) > half - 2)
                            fail("hut by a wall");
                        if (Math.max(Math.abs(hut.x), Math.abs(hut.z)) < 6)
                            fail("hut in the middle");
                    }
                    for (const [index, one] of built.huts.entries())
                        for (const other of built.huts.slice(index + 1))
                            if (Math.max(Math.abs(one.x - other.x), Math.abs(one.z - other.z)) < 6)
                                fail("huts too close");
                    // Boxes never overlap, stay inside, of arena blocks only.
                    const blocks = blocksOf(built.boxes);
                    const { volume } = built;
                    for (const box of built.boxes) {
                        if (!(stage.ARENA_BLOCKS as readonly string[]).includes(box.block))
                            fail(`not an arena block: ${box.block}`);
                        if (
                            Math.min(box.x1, box.x2) < volume.x1 ||
                            Math.max(box.x1, box.x2) > volume.x2 ||
                            Math.min(box.y1, box.y2) < volume.y1 ||
                            Math.max(box.y1, box.y2) > volume.y2 ||
                            Math.min(box.z1, box.z2) < volume.z1 ||
                            Math.max(box.z1, box.z2) > volume.z2
                        )
                            fail("box outside the volume");
                        if (stage.volumeOf(box) > 32_768) fail("box too big for one fill");
                    }
                    const { x, z } = SITE;
                    const outer = half + 1;
                    for (let dx = -outer; dx <= outer; dx += 1)
                        for (let dz = -outer; dz <= outer; dz += 1) {
                            // A whole floor and a whole invisible roof.
                            if (!blocks.has(`${x + dx},${Y},${z + dz}`)) fail("hole in the floor");
                            if (
                                blocks.get(`${x + dx},${Y + acid.ROOF},${z + dz}`) !==
                                "minecraft:barrier"
                            )
                                fail("hole in the roof");
                            // Walls all round, as high as the roof.
                            if (Math.max(Math.abs(dx), Math.abs(dz)) === outer)
                                for (let up = 1; up < acid.ROOF; up += 1)
                                    if (
                                        blocks.get(`${x + dx},${Y + up},${z + dz}`) !==
                                        "minecraft:glass"
                                    )
                                        fail("hole in the wall");
                        }
                    // Under every hut's roof, dry; where everybody starts, wet.
                    for (const hut of built.huts)
                        if (wet(blocks, x + hut.x, Y + 1, z + hut.z)) fail("rain under a hut");
                    for (const spot of acid.spots(built, 8)) {
                        const at = [Math.floor(spot.x), Y + 1, Math.floor(spot.z)] as const;
                        if (blocks.has(at.join(","))) fail("starts inside a block");
                        if (!wet(blocks, ...at)) fail("starts in the dry");
                        if (!acid.inside(built, spot)) fail("starts outside");
                    }
                    // Whatever is placed or left inside is in a sweep box.
                    const sweeps = acid.sweepBoxes(built);
                    for (const block of acid.SHELTER)
                        if (!sweeps.some((box) => box.block === block))
                            fail(`${block} never swept`);
                    for (const box of sweeps)
                        if (
                            box.y1 !== Y + 1 ||
                            box.y2 !== Y + acid.ROOF - 1 ||
                            Math.abs(box.x2 - box.x1) !== 2 * half ||
                            Math.abs(box.z2 - box.z1) !== 2 * half
                        )
                            fail("sweep misses the inside");
                    runs += 1;
                }
        expect(problems.slice(0, 5)).toEqual([]);
        expect(runs).toBe(SIZES.length * ACIDITIES.length * 500);
    }, 180_000);

    it("lays out the same arena for the same run, and other huts for another", () => {
        const one = acid.arena({ size: "medium", acidity: "mild" }, "a", SITE, Y);
        expect(acid.arena({ size: "medium", acidity: "mild" }, "a", SITE, Y)).toEqual(one);
        expect(acid.arena({ size: "medium", acidity: "mild" }, "b", SITE, Y).huts).not.toEqual(
            one.huts
        );
    });

    it("eats faster when harsher, and never less than a couple of blocks a look", () => {
        for (const size of SIZES) {
            const mild = acid.arena({ size, acidity: "mild" }, "s", SITE, Y);
            const harsh = acid.arena({ size, acidity: "harsh" }, "s", SITE, Y);
            expect(harsh.drips).toBeGreaterThan(mild.drips);
            expect(harsh.dose).toBeGreaterThan(mild.dose);
            expect(mild.drips).toBeGreaterThanOrEqual(2);
        }
    });

    it("is taken for an acid arena by its roof, and nothing else is", () => {
        const built = acid.arena({ size: "small", acidity: "mild" }, "r", SITE, Y);
        expect(acid.stopLines(built.boxes)).not.toEqual([]);
        expect(
            acid.stopLines([{ x1: 0, z1: 0, x2: 4, z2: 4, block: "minecraft:snow_block" }])
        ).toEqual([]);
    });
});

describe("the acid rain's data pack", () => {
    const files = snowballPack.packFiles();
    const fn = (name: string) =>
        files.get(`data/polaris/function/acid/${name}.mcfunction`)!.trimEnd().split("\n");

    it("is part of the events pack, in both spellings of the function folders", () => {
        for (const folder of ["functions", "function"])
            expect(files.has(`data/polaris/${folder}/acid/tick.mcfunction`)).toBe(true);
        expect(files.get("data/minecraft/tags/function/tick.json")).toContain("polaris:acid/tick");
    });

    it("never touches the world's weather, and nobody is hurt", () => {
        const built = acid.arena({ size: "large", acidity: "harsh" }, "w", SITE, Y);
        const everything = [
            ...[...files.entries()]
                .filter(([path]) => path.includes("/acid/"))
                .map(([, body]) => body),
            ...acid.armLines(built),
            ...acid.stopLines(built.boxes),
            ...acid.dripLines(built)
        ].join("\n");
        expect(everything).not.toMatch(/\bweather\b/);
        expect(everything).not.toMatch(/\bdamage\b/);
        expect(everything).not.toMatch(/\bkill @a|kill @s|kill @p/);
    });

    it("adds the dose only to whoever is in the rain, and every half second", () => {
        expect(fn("tick")[0]).toBe(
            "execute if score #on polaris_acid matches 1 run function polaris:acid/step"
        );
        expect(fn("step").join("\n")).toContain("matches 10.. run function polaris:acid/beat");
        const expose = fn("expose");
        expect(expose[0]).toBe("tag @s add pe_wet");
        expect(expose.at(-1)).toBe("tag @s remove pe_wet");
        expect(expose.join("\n")).toContain(
            "scoreboard players operation @s[tag=pe_wet] pe_acid += #dose polaris_acid"
        );
    });

    it("eats a shelter one step a drop, and never the floor or the walls", () => {
        const corrode = fn("corrode");
        // Last step first: one drop moves a block one step, never three.
        expect(corrode[0]).toContain(
            "if block ~ ~-1 ~ minecraft:lime_stained_glass run setblock ~ ~-1 ~ minecraft:air"
        );
        expect(corrode[1]).toContain(
            "minecraft:mossy_cobblestone run setblock ~ ~-1 ~ minecraft:lime_stained_glass"
        );
        expect(corrode[2]).toContain(
            "minecraft:cobblestone run setblock ~ ~-1 ~ minecraft:mossy_cobblestone"
        );
        for (const line of corrode)
            expect(line).not.toMatch(/mossy_stone_bricks|minecraft:glass |barrier/);
        const built = acid.arena({ size: "medium", acidity: "mild" }, "d", SITE, Y);
        const [spread] = acid.dripLines(built);
        expect(spread).toContain(`under ${Y + acid.ROOF - 1} false`);
        expect(spread).toContain(`1 ${built.half} `);
    });

    it("is armed for one arena, switch last, and only that arena's end switches it off", () => {
        const one = acid.arena({ size: "small", acidity: "mild" }, "arm", SITE, Y);
        const other = acid.arena({ size: "small", acidity: "mild" }, "arm", { x: 900, z: 900 }, Y);
        const arm = acid.armLines(one);
        expect(arm.at(-1)).toBe("scoreboard players set #on polaris_acid 1");
        expect(arm.indexOf("scoreboard players set #on polaris_acid 0")).toBeLessThan(
            arm.findIndex((line) => line.includes("summon"))
        );
        expect(
            arm.filter((line) => line.includes("polaris_acid_drip") && line.includes("summon"))
        ).toHaveLength(one.drips);
        expect(acid.stopLines(one.boxes)).not.toEqual(acid.stopLines(other.boxes));
        expect(acid.stopLines(one.boxes).at(-1)).toContain(
            "scoreboard players set #on polaris_acid 0"
        );
        expect(acid.stopLines([])).toEqual([]);
    });

    it("draws the rain for every size the catalog offers", () => {
        const step = fn("step").join("\n");
        for (const size of SIZES) expect(step).toContain(`matches ${acid.HALF[size]} as`);
    });
});

describe("what an acid rain hands out and says", () => {
    it("hands out cobblestone that only goes on the arena, in both item syntaxes", () => {
        const now = acid.cobblestoneLine("Ana", "components", 16);
        expect(now).toContain("minecraft:custom_data={polaris_event:1b}");
        expect(now).toContain("minecraft:can_place_on=");
        expect(now).toMatch(/ 16$/);
        const old = acid.cobblestoneLine("Ana", "nbt", 8);
        expect(old).toContain("polaris_event:1b");
        expect(old).toContain("CanPlaceOn:[");
        expect(stage.clearMarked("Ana", "nbt")).toContain(
            "clear Ana minecraft:cobblestone{polaris_event:1b}"
        );
    });

    it("ranks those out by when they went, and those still in by how dry they stayed", () => {
        expect(acid.scoreOf(3, null)).toBeLessThan(acid.scoreOf(4, 0));
        expect(acid.scoreOf(4, 80)).toBeGreaterThan(acid.scoreOf(4, 20));
        expect(acid.scoreParts(acid.scoreOf(4, 73))).toEqual({ place: 4, dry: 73 });
        expect(acid.dryOf(130)).toBe(0);
        expect(acid.dryOf(-5)).toBe(acid.ACID_MAX);
        expect(acid.gauge(0)).not.toBe(acid.gauge(acid.ACID_MAX));
    });

    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const)
            for (const line of [
                said.readySubtitle(language),
                said.goTitle(language),
                said.goSubtitle(language),
                said.bar(acid.gauge(40), 3, language),
                said.topUp(8, language),
                said.dissolved("Ana", 2, language),
                said.cannotPlay(language)
            ])
                expect(line.length).toBeGreaterThan(5);
        expect(said.goSubtitle("es")).not.toBe(said.goSubtitle("en"));
        const built = acid.arena({ size: "large", acidity: "harsh" }, "size", SITE, Y);
        for (const line of [
            ...built.boxes.map(stage.buildLine),
            ...acid.sweepBoxes(built).map(stage.buildLine),
            ...acid.armLines(built),
            ...acid.dripLines(built),
            acid.cobblestoneLine("Ana_with_a_long", "components", 16)
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });

    it("needs 1.17, for where the rain lands", () => {
        const preset = catalog.newPreset("acid-rain", "acid");
        expect(catalog.incompatibility(preset, "1.16.5")).toEqual({ why: "arena", needs: "1.17" });
        expect(catalog.incompatibility(preset, "1.17.1")).toBeNull();
        expect(catalog.incompatibility(preset, "1.21.4")).toBeNull();
    });
});
