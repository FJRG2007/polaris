/**
 * No event map sets a spawn point. A bed or a respawn anchor sets the spawn of
 * whoever sleeps in it or clicks it - in adventure mode too - so after the
 * event a player who died was sent back to a house in the sky that was gone.
 *
 * Every hide and seek house a run can draw today is walked block by block, at
 * every size, on every server age, over many seeds and draws; and every event
 * builder's source is searched, so a bed added to any other map fails here too.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as rooms from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-rooms";

const SETS_SPAWN = /(^|:)([a-z_]+_)?bed$|(^|:)respawn_anchor$/;

const ERAS: readonly model.Era[] = [
    model.OLDEST,
    { scaffold: true, snow: false, display: false },
    { scaffold: true, snow: true, display: false },
    model.NEWEST
];

const EVENTS = join(__dirname, "../../../game-servers/src/lib/minecraft/events");

function sourcesIn(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourcesIn(path));
        else if (entry.name.endsWith(".ts")) out.push(path);
    }
    return out;
}

describe("no event map sets a spawn point", () => {
    it("knows the blocks that do", () => {
        for (const id of ["red_bed", "white_bed", "minecraft:light_blue_bed", "respawn_anchor"])
            expect(SETS_SPAWN.test(id)).toBe(true);
        for (const id of ["bedrock", "minecraft:red_carpet", "oak_slab", "seabed"])
            expect(SETS_SPAWN.test(id)).toBe(false);
    });

    it("puts none in any hide and seek house, at any size, on any server age", () => {
        expect(manor.DESIGN).toBeGreaterThanOrEqual(rooms.BEDLESS_SINCE);
        const found = new Set<string>();
        let bedrooms = 0;
        for (const count of [3, 4, 5])
            for (const era of ERAS)
                for (let seed = 0; seed < 16; seed += 1)
                    for (let draw = 0; draw < 3; draw += 1) {
                        const house = manor.drawManor(`spawn-${seed}`, count, era, draw);
                        bedrooms += house.rooms.filter((one) => one.template === "bedroom").length;
                        for (let level = model.DEEP; level < model.ROOF; level += 1)
                            for (let x = 0; x < house.grid.size; x += 1)
                                for (let z = 0; z < house.grid.size; z += 1) {
                                    const block = house.grid.get(x, level, z);
                                    if (block && SETS_SPAWN.test(model.bare(block)))
                                        found.add(`${block} in a house of ${count}`);
                                }
                    }
        // The bedroom is drawn, with its look-alikes, and never a bed.
        expect(bedrooms).toBeGreaterThan(0);
        expect([...found]).toEqual([]);
    });

    it("is in no event builder's source, but for the houses older runs still rebuild", () => {
        const files = sourcesIn(EVENTS);
        expect(files.length).toBeGreaterThan(20);
        const offenders: string[] = [];
        for (const file of files) {
            const lines = readFileSync(file, "utf8").split("\n");
            lines.forEach((line, index) => {
                if (!/minecraft:([a-z_]+_)?bed\b|respawn_anchor/.test(line)) return;
                // Drawn only for a house built before `BEDLESS_SINCE`, so a run
                // picked up after an update rebuilds and takes down what it built.
                const legacy =
                    file.endsWith("seek-rooms.ts") &&
                    lines
                        .slice(Math.max(0, index - 10), index)
                        .some((one) => one.includes("BEDLESS_SINCE"));
                if (!legacy) offenders.push(`${file.slice(EVENTS.length + 1)}:${index + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });
});
