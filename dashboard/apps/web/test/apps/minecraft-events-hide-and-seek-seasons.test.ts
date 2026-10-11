/**
 * Hide and seek's seasonal rooms: a house built while the server is dressed
 * for Halloween or for winter draws that season's rooms - at least one of
 * them - and keeps every rule with them; out of season, and for a house built
 * before there were any, it never draws one and is drawn exactly as before.
 * The season is decided once, from the date the house is built on, and kept
 * with the run. In season the house's own rooms get a touch of it as well.
 *
 * And the aquarium (design 8), drawn in every season: its water is sealed in
 * glass on every side, and its fish leave nothing behind.
 */

import { describe, expect, it } from "vitest";
import * as seasonal from "@polaris-app/game-servers/src/lib/minecraft/seasonal";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as rooms from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-rooms";

const SEASONS = ["halloween", "winter"] as const;
const namesOf = (season: seasonal.Decoration) =>
    rooms.SEASONAL.filter((one) => one.season === season).map((one) => one.name);
const ALL = rooms.SEASONAL.map((one) => one.name);

/** Blocks that fall, freeze a player in place or go up in flames. */
const FORBIDDEN =
    /(powder_snow|sand$|gravel|concrete_powder|anvil|scaffolding|pointed_dripstone|tnt|^minecraft:fire$|magma|lava)/;

/** Everything a template draws, on a canvas that takes it all. */
function drawn(template: rooms.Template, era: model.Era) {
    const blocks: string[] = [];
    const spots: number[][] = [];
    let hooks = 0;
    const canvas: rooms.Canvas = {
        random: () => 0.3,
        era,
        design: manor.DESIGN,
        style: template.style,
        doors: [],
        set: (block) => void blocks.push(block),
        clear: () => {},
        free: () => true,
        floorPanel: () => {},
        wallPanel: () => true,
        display: (block) => void blocks.push(block),
        hook: () => void (hooks += 1),
        spot: (u, feet, v) => void spots.push([u, feet, v]),
        pad: () => {},
        fish: () => {}
    };
    template.draw(canvas);
    return { blocks: blocks.map(model.bare), spots, hooks };
}

describe("hide and seek's seasonal rooms", () => {
    it("are only ones a season names, with a hiding place and keys each, and nothing that falls or burns", () => {
        expect(namesOf("halloween").length).toBeGreaterThanOrEqual(2);
        expect(namesOf("winter").length).toBeGreaterThanOrEqual(2);
        for (const template of rooms.SEASONAL) {
            expect(template.season).toBeDefined();
            expect(rooms.TEMPLATES).not.toContain(template);
            const { blocks, spots, hooks } = drawn(template, model.NEWEST);
            expect(
                blocks.filter((id) => FORBIDDEN.test(id)),
                template.name
            ).toEqual([]);
            expect(spots.length, template.name).toBeGreaterThan(0);
            expect(hooks, template.name).toBeGreaterThanOrEqual(3);
        }
    });

    it("leave out a room the server cannot show: no campfire before 1.14", () => {
        for (const template of rooms.SEASONAL) {
            const shown = !template.fits || template.fits(model.OLDEST);
            const { blocks } = drawn(template, model.OLDEST);
            if (shown)
                expect(
                    blocks.filter((id) => /campfire/.test(id)),
                    template.name
                ).toEqual([]);
        }
    });

    it("draws its season's rooms in season, at least one a house, and keeps every rule", () => {
        for (const season of SEASONS) {
            const seen = new Set<string>();
            for (const era of [model.NEWEST, model.OLDEST])
                for (let seed = 0; seed < 8; seed += 1) {
                    const house = manor.manorFor(`season-${seed}`, 3, era, manor.DESIGN, season);
                    expect(house.bare, `${season} ${seed}`).toBeFalsy();
                    expect(manor.manorProblems(house)).toEqual([]);
                    const names = house.rooms.map((room) => room.template);
                    expect(names.some((name) => namesOf(season).includes(name))).toBe(true);
                    expect(
                        names.filter(
                            (name) => ALL.includes(name) && !namesOf(season).includes(name)
                        )
                    ).toEqual([]);
                    for (const name of names) seen.add(name);
                    // Nothing in it that falls or freezes a player in place.
                    expect(
                        manor
                            .manorBlocks(house)
                            .filter((id) => /powder_snow|gravel|concrete_powder/.test(id))
                    ).toEqual([]);
                }
            for (const name of namesOf(season)) expect(seen, `${season} ${name}`).toContain(name);
        }
    }, 60_000);

    it("never draws one out of season, and draws the house exactly as before", () => {
        for (let seed = 0; seed < 8; seed += 1) {
            const before = manor.manorFor(`out-${seed}`, 3, model.NEWEST);
            const out = manor.manorFor(`out-${seed}`, 3, model.NEWEST, manor.DESIGN, null);
            expect(out.rooms).toEqual(before.rooms);
            expect(out.rooms.filter((room) => ALL.includes(room.template))).toEqual([]);
        }
        // Nor in a house an older design built, whatever the season.
        for (let seed = 0; seed < 4; seed += 1) {
            const old = manor.manorFor(`old-${seed}`, 3, model.NEWEST, 6, "halloween");
            expect(old.rooms.filter((room) => ALL.includes(room.template))).toEqual([]);
        }
    }, 60_000);

    it("is decided by the date the house is built on and the server's switches", () => {
        const on = (date: string, extra: Partial<seasonal.SeasonInputs> = {}) =>
            seasonal.decorationNow({
                now: new Date(date),
                timeZone: "UTC",
                allowed: true,
                serverOn: true,
                eventRunning: false,
                ...extra
            });
        expect(on("2026-10-20T12:00:00Z")).toBe("halloween");
        expect(on("2026-12-20T12:00:00Z")).toBe("winter");
        expect(on("2026-07-01T12:00:00Z")).toBeNull();
        expect(on("2026-10-20T12:00:00Z", { serverOn: false })).toBeNull();
        expect(on("2026-12-20T12:00:00Z", { allowed: false })).toBeNull();
    });

    it("is kept with the run, and a run from before has none", () => {
        expect(hs.stateSchema.parse({ season: "winter" }).season).toBe("winter");
        expect(hs.stateSchema.parse({}).season).toBeNull();
        expect(hs.stateSchema.parse({ season: "spring" }).season).toBeNull();
    });

    it("dresses the house's own rooms in season, and leaves them as they were out of it", () => {
        const banners = (house: manor.Manor, colour: string) =>
            manor.manorBlocks(house).includes(`minecraft:${colour}_wall_banner`);
        let halloween = 0;
        let winter = 0;
        for (let seed = 0; seed < 6; seed += 1) {
            const dressed = (season: seasonal.Decoration) =>
                manor.manorFor(`dress-${seed}`, 3, model.NEWEST, manor.DESIGN, season);
            if (banners(dressed("halloween"), "purple")) halloween += 1;
            if (banners(dressed("winter"), "green")) winter += 1;
            const out = manor.manorFor(`dress-${seed}`, 3, model.NEWEST);
            for (const colour of ["purple", "green", "orange"])
                expect(banners(out, colour)).toBe(false);
            expect(manor.manorBlocks(out)).not.toContain("minecraft:cobweb");
        }
        expect(halloween).toBeGreaterThan(0);
        expect(winter).toBeGreaterThan(0);
    }, 30_000);
});

describe("hide and seek's aquarium (design 8)", () => {
    const span = model.ROOM + model.WALL;
    const inAquarium = (house: manor.Manor, x: number, z: number) => {
        const i = Math.floor((x - model.WALL) / span);
        const j = Math.floor((z - model.WALL) / span);
        return house.rooms.some(
            (room) => room.i === i && room.j === j && room.template === "aquarium"
        );
    };
    const housesWith = (era: model.Era) => {
        const out: manor.Manor[] = [];
        for (let seed = 0; seed < 30 && out.length < 4; seed += 1) {
            const house = manor.manorFor(`aquarium-${seed}`, 3, era);
            if (house.rooms.some((room) => room.template === "aquarium")) out.push(house);
        }
        return out;
    };
    const SIX = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1]
    ] as const;

    it("seals its water in on every side, with fish in it", () => {
        for (const era of [model.NEWEST, model.OLDEST]) {
            const houses = housesWith(era);
            expect(houses.length).toBeGreaterThan(0);
            for (const house of houses) {
                expect(manor.manorProblems(house)).toEqual([]);
                const { grid } = house;
                let water = 0;
                for (let x = 0; x < grid.size; x += 1)
                    for (let z = 0; z < grid.size; z += 1)
                        for (let level = model.DEEP; level < model.ROOF; level += 1) {
                            if (!inAquarium(house, x, z)) continue;
                            if (model.bare(grid.get(x, level, z) ?? "") !== "minecraft:water")
                                continue;
                            water += 1;
                            for (const [dx, dl, dz] of SIX)
                                expect(
                                    grid.get(x + dx, level + dl, z + dz),
                                    `${x},${level},${z}`
                                ).toBeTruthy();
                        }
                expect(water).toBeGreaterThan(0);
                expect(house.fish.length).toBeGreaterThan(0);
                for (const fish of house.fish)
                    expect(model.bare(grid.get(fish.x, fish.level, fish.z) ?? "")).toBe(
                        "minecraft:water"
                    );
            }
        }
    }, 30_000);

    it("summons its fish kept, unharmed and with nothing to drop, and takes it all down", () => {
        const house = housesWith(model.NEWEST)[0]!;
        const box = manor.hallBox({ x: 0, z: 0 }, 100, house.count);
        const fish = manor.decorLines(box, house).filter((line) => line.includes("tropical_fish"));
        expect(fish.length).toBe(house.fish.length);
        for (const line of fish) {
            expect(line).toContain('DeathLootTable:"minecraft:empty"');
            expect(line).toContain("PersistenceRequired:1b");
            expect(line).toContain("pe_hs_deco");
        }
        // Down before the glass: the plants that hold water and the water;
        // and a coral block's dead self with it.
        const blocks = manor.manorBlocks(house);
        const glass = blocks.indexOf("minecraft:glass");
        for (const id of blocks.filter((one) => /kelp|sea_pickle|water/.test(one)))
            expect(blocks.indexOf(id)).toBeLessThan(glass);
        for (const id of blocks.filter((one) => /^minecraft:(?!dead_)\w+_coral_block$/.test(one)))
            expect(blocks).toContain(id.replace("minecraft:", "minecraft:dead_"));
    }, 30_000);

    it("is never drawn in a house an older design built", () => {
        for (let seed = 0; seed < 12; seed += 1) {
            const house = manor.manorFor(`aquarium-old-${seed}`, 3, model.NEWEST, 7);
            expect(house.rooms.filter((room) => room.template === "aquarium")).toEqual([]);
        }
    }, 30_000);
});
