/**
 * Acid rain (`kinds/acid-rain`): its arena checked against its rules over
 * thousands of runs, who the data pack takes for out in the rain over the
 * blocks the arena is built of, what the rain eats and what it leaves, its
 * waves of weather and what they bring, and that the world's weather is never
 * touched.
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
/** A six-minute run's weather, and its first spell. */
const SIX = 6 * 60_000;
const first = (huts = 4) => acid.forecast(SIX, "run-1", huts)[0]!;

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
            ...acid.armLines(built, first()),
            ...acid.stopLines(built.boxes),
            ...acid.dripLines(built),
            ...acid.dropLines(built, ["blocks", "antidote", "umbrella"], "components"),
            acid.strikeLine(built),
            ...acid.collapseLines(built, 0)
        ].join("\n");
        expect(everything).not.toMatch(/\bweather (clear|rain|thunder)\b/);
        expect(everything).not.toMatch(/\bdamage\b/);
        expect(everything).not.toMatch(/summon minecraft:lightning_bolt/);
        // Only the pack's own stands and supplies are ever killed.
        for (const kill of everything.matchAll(/\bkill (\S+)/g))
            expect(kill[1]).toMatch(/^@[es]\[type=minecraft:(armor_stand|item),tag=/);
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
        const arm = acid.armLines(one, first());
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
        for (const size of SIZES) expect(step).toContain(`matches ${acid.HALF[size]} if score`);
    });
});

describe("an acid rain's pack, on every release it is loaded on", () => {
    // The pack is put on servers from 1.13 for other games too, and a release
    // that cannot read one line of a function drops the whole function: every
    // particle and sound the acid functions name has to be one 1.13 knows.
    const PARTICLES_1_13 = new Set([
        "minecraft:item_slime",
        "minecraft:happy_villager",
        "minecraft:heart",
        "minecraft:totem_of_undying",
        "minecraft:end_rod",
        "minecraft:explosion"
    ]);
    const SOUNDS_1_13 = new Set([
        "minecraft:block.fire.extinguish",
        "minecraft:entity.player.levelup",
        "minecraft:entity.lightning_bolt.thunder",
        "minecraft:entity.lightning_bolt.impact"
    ]);
    const lines = Object.values(acid.FUNCTIONS).flat();

    it("names only particles and sounds 1.13 knows, and no newer command", () => {
        for (const line of lines) {
            for (const [, id] of line.matchAll(/\bparticle (\S+)/g))
                expect(PARTICLES_1_13).toContain(id);
            for (const [, id] of line.matchAll(/\bplaysound (\S+)/g))
                expect(SOUNDS_1_13).toContain(id);
            // `spreadplayers ... under` (1.17), `item` (1.17), components (1.20.5)
            // and `ride` (1.19.4) are sent over RCON, where the version is known.
            expect(line).not.toMatch(/\b(spreadplayers|item replace|ride|summon)\b|\[minecraft:/);
        }
    });

    it("calls only functions it has", () => {
        for (const line of lines)
            for (const [, name] of line.matchAll(/function polaris:acid\/(\w+)/g))
                expect(Object.keys(acid.FUNCTIONS)).toContain(name);
    });
});

describe("an acid rain's weather", () => {
    it("opens with a drizzle, then surges, calms and drizzles, and ends in a downpour", () => {
        const spells = acid.forecast(SIX, "w", 4);
        expect(spells[0]).toMatchObject({ sky: "drizzle", from: 0, to: acid.OPENING_MS });
        expect(spells.at(-1)).toMatchObject({ sky: "downpour", to: SIX });
        // A minute, or a little more where a stretch too short to play joins it.
        expect(spells.at(-1)!.from).toBeLessThanOrEqual(SIX - acid.DOWNPOUR_MS);
        expect(spells.at(-1)!.from).toBeGreaterThan(SIX - acid.DOWNPOUR_MS - 5_000);
        expect(spells.slice(1, 4).map((one) => one.sky)).toEqual(["surge", "calm", "drizzle"]);
        // One after another, nothing missing, nothing twice.
        for (const [index, one] of spells.entries()) {
            expect(one.to).toBeGreaterThan(one.from);
            if (index > 0) expect(one.from).toBe(spells[index - 1]!.to);
        }
        // Surges counted up from 1, calms from 0.
        const surges = spells.filter((one) => one.sky === "surge");
        expect(surges.map((one) => one.level)).toEqual(surges.map((_, index) => index + 1));
        const calms = spells.filter((one) => one.sky === "calm");
        expect(calms.map((one) => one.calm)).toEqual(calms.map((_, index) => index));
        // Wind every second surge; huts fall from the second.
        expect(surges[0]!.wind).toBe(0);
        expect(surges[1]!.wind).toBeGreaterThan(0);
        expect(surges[0]!.collapse).toBeNull();
        expect(surges[1]!.collapse).toBe(0);
    });

    it("keeps every rule for every length and seed", () => {
        const problems: string[] = [];
        for (let minutes = 1; minutes <= 30; minutes += 1)
            for (let seed = 0; seed < 40; seed += 1) {
                const total = minutes * 60_000;
                const spells = acid.forecast(total, `s-${seed}`, 3);
                const fail = (what: string) => problems.push(`${minutes} ${seed}: ${what}`);
                if (spells[0]?.from !== 0) fail("does not start at Go");
                if (spells.at(-1)?.to !== total || spells.at(-1)?.sky !== "downpour")
                    fail("does not end in a downpour");
                const downpour = spells.at(-1)!;
                if (downpour.to - downpour.from > acid.DOWNPOUR_MS + 5_000)
                    fail("downpour too long");
                const collapsed = spells.flatMap((one) =>
                    one.collapse === null ? [] : [one.collapse]
                );
                if (new Set(collapsed).size !== collapsed.length) fail("a hut falls twice");
                if (collapsed.some((hut) => hut < 0 || hut >= 3)) fail("no such hut");
                for (const one of spells) {
                    if (one.sky !== "downpour" && one.to - one.from < 5_000) fail("a sliver");
                    if (one.sky === "calm" && (one.wind !== 0 || one.strikes.length > 0))
                        fail("a stormy calm");
                    if (one.strikes.some((when) => when < one.from || when >= one.to))
                        fail("a strike outside its spell");
                    if (one.wind < 0 || one.wind > 4) fail("no such wind");
                }
            }
        expect(problems.slice(0, 5)).toEqual([]);
    });

    it("is the same weather for the same run, whatever looks at it", () => {
        expect(acid.forecast(SIX, "a", 4)).toEqual(acid.forecast(SIX, "a", 4));
        expect(acid.forecast(0, "a", 4)).toEqual([]);
    });

    it("finds the spell for any moment, the last one past the end", () => {
        const spells = acid.forecast(SIX, "w", 4);
        expect(acid.spellAt(spells, 0)).toBe(0);
        expect(acid.spellAt(spells, acid.OPENING_MS)).toBe(1);
        expect(acid.spellAt(spells, SIX + 10_000)).toBe(spells.length - 1);
        expect(acid.spellAt([], 5)).toBe(-1);
    });

    it("rains harder as it goes, and not at all in a calm", () => {
        const built = acid.arena({ size: "medium", acidity: "mild" }, "d", SITE, Y);
        const dose = (sky: acid.Sky, level = 0) => acid.doseOf(built, { sky, level });
        expect(dose("calm")).toBe(0);
        expect(dose("drizzle")).toBeGreaterThan(0);
        expect(dose("drizzle")).toBeLessThan(dose("surge", 1));
        expect(dose("surge", 3)).toBeGreaterThan(dose("surge", 1));
        expect(dose("downpour")).toBeGreaterThan(dose("surge", 3));
        expect(acid.biteOf(built, { sky: "surge", level: 2 })).toBeLessThan(
            acid.biteOf(built, { sky: "drizzle", level: 0 })
        );
        expect(acid.biteOf(built, { sky: "downpour", level: 9 })).toBe(acid.FASTEST_BITE);
        expect(acid.rainOf({ sky: "calm" })).toBe(0);
        expect(acid.rainOf({ sky: "downpour" })).toBeGreaterThan(acid.rainOf({ sky: "surge" }));
        // What the pack is told: the calm switches the rain and its bites off.
        const calm = acid.forecast(SIX, "w", 4).find((one) => one.sky === "calm")!;
        expect(acid.skyLines(built, calm)).toContain("scoreboard players set #dose polaris_acid 0");
        expect(acid.skyLines(built, calm)).toContain("scoreboard players set #rain polaris_acid 0");
        expect(acid.FUNCTIONS.beat!.join("\n")).toContain(
            "execute if score #dose polaris_acid matches 1.. if score #b polaris_acid >= #bite polaris_acid run function polaris:acid/bites"
        );
    });

    it("blows the rain in from the wind's side: a block there, at the feet or the head, covers it", () => {
        const gust = acid.FUNCTIONS.gust!;
        expect(gust[0]).toBe("tag @s add pe_wet");
        expect(gust).toContain(
            "execute if score #wind polaris_acid matches 1 unless block ~ ~ ~-1 minecraft:air run tag @s remove pe_wet"
        );
        expect(gust).toContain(
            "execute if score #wind polaris_acid matches 2 unless block ~1 ~1 ~ minecraft:air run tag @s remove pe_wet"
        );
        expect(gust).toHaveLength(9);
        // Only for whoever a roof already covers.
        expect(acid.FUNCTIONS.expose).toContain(
            "execute if score #wind polaris_acid matches 1.. if entity @s[tag=!pe_wet] run function polaris:acid/gust"
        );
    });
});

describe("what an acid rain changes on the board", () => {
    const built = () => acid.arena({ size: "small", acidity: "mild" }, "b", SITE, Y);

    it("strikes only somebody under cover, far enough in that it never reaches past a wall", () => {
        const one = built();
        const line = acid.strikeLine(one);
        const edge = one.half - 1;
        expect(line).toContain("@r[tag=pe_dry,");
        expect(line).toContain(`x=${SITE.x - edge},y=${Y},z=${SITE.z - edge},dx=${2 * edge}`);
        expect(line).toContain(`positioned ~ ${Y + 1} ~ run function polaris:acid/strike`);
        // From the floor up to under the roof, three by three, shelter only.
        const strike = acid.FUNCTIONS.strike!;
        for (const block of acid.SHELTER)
            expect(strike).toContain(
                `fill ~-1 ~ ~-1 ~1 ~${acid.ROOF - 2} ~1 minecraft:air replace ${block}`
            );
        for (const fill of strike.filter((one) => one.startsWith("fill")))
            expect(fill).toMatch(
                /minecraft:air replace minecraft:(cobblestone|mossy_cobblestone|lime_stained_glass)$/
            );
    });

    it("brings a hut down, its blocks and whatever was built onto them, and nothing else", () => {
        const one = built();
        const lines = acid.collapseLines(one, 0);
        const hut = one.huts[0]!;
        expect(lines.filter((line) => line.includes(" fill "))).toHaveLength(acid.SHELTER.length);
        expect(lines[0]).toContain(
            `fill ${SITE.x + hut.x - 1} ${Y + 1} ${SITE.z + hut.z - 1} ${SITE.x + hut.x + 1} ${Y + 4} ${SITE.z + hut.z + 1} minecraft:air replace`
        );
        expect(acid.collapseLines(one, 99)).toEqual([]);
    });

    it("drops supplies for the players left, an umbrella every second calm", () => {
        expect(acid.cratesFor(0, 1)).toEqual(["blocks", "antidote"]);
        expect(acid.cratesFor(1, 8)).toEqual([
            "blocks",
            "blocks",
            "blocks",
            "blocks",
            "antidote",
            "umbrella"
        ]);
        expect(acid.cratesFor(2, 40).length).toBeLessThanOrEqual(6);
        const drop = acid.dropLines(built(), ["blocks", "umbrella"], "components");
        expect(drop[0]).toBe("kill @e[type=minecraft:item,tag=polaris_acid_crate]");
        expect(drop[1]).toContain('{Item:{id:"minecraft:chest",count:1},PickupDelay:32767');
        expect(drop[2]).toContain('{Item:{id:"minecraft:shield",count:1}');
        expect(acid.dropLines(built(), ["blocks"], "nbt")[1]).toContain("Count:1b}");
        expect(drop.at(-2)).toContain(
            `under ${Y + acid.ROOF - 1} false @e[type=minecraft:item,tag=pe_crate_new]`
        );
        expect(drop.at(-1)).toBe(
            "tag @e[type=minecraft:item,tag=pe_crate_new] remove pe_crate_new"
        );
    });

    it("counts what was picked up one supply a digit, and never loses one picked meanwhile", () => {
        expect(acid.gotOf(0)).toEqual({ blocks: 0, antidote: 0, umbrella: 0 });
        expect(acid.gotOf(112)).toEqual({ blocks: 2, antidote: 1, umbrella: 1 });
        expect(acid.gotTakenLines("Ana", 12)).toEqual([
            "scoreboard players remove Ana pe_acidg 12"
        ]);
        const take = acid.FUNCTIONS.take!;
        expect(take).toContain(
            `execute if entity @s[tag=pe_crate_c] run scoreboard players remove @a[tag=pe_taker] pe_acid ${acid.CURE}`
        );
        // An antidote never takes anybody below nothing.
        expect(take).toContain(
            "scoreboard players set @a[tag=pe_taker,scores={pe_acid=..-1}] pe_acid 0"
        );
        expect(take.at(-1)).toBe("kill @s[type=minecraft:item,tag=polaris_acid_crate]");
        // Whoever holds an umbrella is not looked at for rain.
        expect(acid.FUNCTIONS.beat!.join("\n")).toContain(
            "scores={pe_acid=0..,pe_acids=..0}] at @s run function polaris:acid/expose"
        );
    });

    it("tells who is in the rain from two looks at their acid", () => {
        expect(acid.coverOf(undefined, 30, 0)).toBe("dry");
        expect(acid.coverOf(20, 30, 0)).toBe("wet");
        expect(acid.coverOf(30, 30, 0)).toBe("dry");
        expect(acid.coverOf(50, 15, 0)).toBe("dry");
        expect(acid.coverOf(20, 30, 4)).toBe("umbrella");
    });

    it("leaves nothing behind: every block it puts down is one its teardown takes", () => {
        // The blocks every line can put down - what the arena is built of,
        // what the rain turns a shelter into, what players are handed - all
        // swept by the arena's own boxes or by `sweepBoxes`.
        for (const size of SIZES) {
            const one = acid.arena({ size, acidity: "harsh" }, "sweep", SITE, Y);
            const taken = new Set(
                [...one.boxes, ...acid.sweepBoxes(one)].map((box) => box.block as string)
            );
            const placed = new Set<string>(["minecraft:cobblestone"]);
            const lines = [
                ...Object.values(acid.FUNCTIONS).flat(),
                ...acid.armLines(one, first()),
                ...acid.dripLines(one),
                ...acid.collapseLines(one, 0),
                acid.strikeLine(one),
                ...acid.dropLines(one, ["blocks", "antidote", "umbrella"], "components")
            ];
            for (const line of lines) {
                const set = /\b(?:setblock (?:\S+ ){3}|fill (?:\S+ ){6})(minecraft:[a-z_]+)/.exec(
                    line
                );
                if (set && set[1] !== "minecraft:air") placed.add(set[1]!);
            }
            for (const box of one.boxes) placed.add(box.block);
            expect([...placed].filter((block) => !taken.has(block))).toEqual([]);
            expect(placed).toContain("minecraft:mossy_cobblestone");
            expect(placed).toContain("minecraft:lime_stained_glass");
        }
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
                said.bar("wet", acid.gauge(40), 40, 0, 3, language),
                said.bar("umbrella", acid.gauge(40), 40, 6, 3, language),
                said.skyBar(
                    { sky: "surge", level: 2, wind: 3 },
                    { sky: "calm", level: 0 },
                    "0:12",
                    language
                ),
                said.skyBar({ sky: "downpour", level: 5, wind: 1 }, null, "0:48", language),
                said.skySubtitle("calm", 0, language),
                said.calmLine(12, 35, 10, language),
                said.picked("antidote", 35, language),
                said.sidebarTitle(language),
                said.collapsed(language),
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
            ...acid.armLines(built, first()),
            ...acid.dripLines(built),
            ...acid.dropLines(built, ["blocks", "antidote", "umbrella"], "nbt"),
            ...acid.collapseLines(built, 0),
            acid.strikeLine(built),
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

describe("a shelter in the acid rain", () => {
    const built = () => acid.arena({ size: "medium", acidity: "mild" }, "run-1", SITE, Y);

    it("is bitten from below over the head of whoever is under it, a step at a time", () => {
        const bite = acid.FUNCTIONS.bite!;
        // One look per block over the head, each only while nothing was bitten yet.
        expect(bite.filter((line) => line.includes("function polaris:acid/gnaw"))).toHaveLength(
            acid.ROOF
        );
        expect(acid.FUNCTIONS.gnaw).toContain("function polaris:acid/corrode");
        expect(acid.FUNCTIONS.beat!.some((line) => line.includes("polaris:acid/bites"))).toBe(true);
        expect(acid.armLines(built(), first())).toContain(
            `scoreboard players set #bite ${acid.OBJECTIVE} ${acid.BITE_BEATS.mild}`
        );
    });

    it("is bitten faster each surge, never below the fastest bite", () => {
        const one = built();
        expect(acid.biteBeats(one, 0)).toBe(acid.BITE_BEATS.mild);
        expect(acid.biteBeats(one, 1)).toBe(acid.BITE_BEATS.mild / 2);
        expect(acid.biteBeats(one, 20)).toBe(acid.FASTEST_BITE);
    });

    it("is explained at Go in both languages", () => {
        for (const language of ["en", "es"] as const) {
            expect(said.howItWorks(language).length).toBeGreaterThan(40);
            expect(said.goSubtitle(language)).toMatch(/cover|cubierto/);
        }
    });
});
