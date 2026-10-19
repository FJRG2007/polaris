/**
 * The builds Polaris ships: the seasonal ones placed in the world and the
 * event arenas made from real builds. Every file decodes and fills the box it
 * declares, and every arena keeps its event's gameplay contract.
 */

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/world-builds/plan";
import * as format from "@polaris-app/game-servers/src/lib/minecraft/world-builds/format";
import * as arenas from "@polaris-app/game-servers/src/lib/minecraft/world-builds/arenas";
import { WORLD_BUILDS } from "@polaris-app/game-servers/src/lib/minecraft/world-builds/catalog";
import * as spleef from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef";
import * as tntRun from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tnt-run";
import * as stageService from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage-service";

const BUILDS_DIR = new URL(
    "../../../game-servers/src/lib/minecraft/world-builds/builds/",
    import.meta.url
);

const solid = (build: format.BuildCells) => format.decodeCells(build).filter(Boolean).length;

describe("seasonal build catalogue", () => {
    it("loads every build, four for each season", () => {
        expect(WORLD_BUILDS.map((one) => one.id).sort()).toEqual([
            "gift-pile",
            "graveyard-corner",
            "pumpkin-patch",
            "scarecrow",
            "snow-bench",
            "snowman",
            "winter-spruce",
            "witch-cauldron"
        ]);
        expect(WORLD_BUILDS.filter((one) => one.season === "winter")).toHaveLength(4);
        expect(WORLD_BUILDS.filter((one) => one.season === "halloween")).toHaveLength(4);
    });

    it("decodes every build to exactly its declared footprint, within a site's size", () => {
        for (const build of WORLD_BUILDS) {
            const { x, y, z } = build.size;
            expect(format.decodeCells(build)).toHaveLength(x * y * z);
            expect(Math.max(x, y, z)).toBeLessThanOrEqual(format.SIDE_MAX);
            expect(solid(build)).toBeGreaterThan(0);
            expect(format.polarisBuildSchema.parse(build)).toEqual(build);
        }
    });

    it("pastes every block a build has, and nothing that flows", () => {
        for (const build of WORLD_BUILDS) {
            const pieces = plan.pastePieces(build, { x: 0, y: 64, z: 0 });
            expect(pieces.reduce((sum, one) => sum + one.blocks, 0)).toBe(solid(build));
            expect(build.palette.some((one) => /^minecraft:(water|lava)\b/.test(one))).toBe(false);
        }
    });
});

describe("arenas from builds", () => {
    it("ships a file for every catalogue entry, and no file outside one", () => {
        const files = readdirSync(BUILDS_DIR).map((one) => one.replace(/\.json$/, ""));
        const listed = [
            ...WORLD_BUILDS.map((one) => one.id),
            ...arenas.ARENA_BUILDS.map((one) => one.build.id)
        ];
        expect(listed.sort()).toEqual(files.sort());
    });

    it("keeps every declared arena: each decodes, fits its box and meets its contract", () => {
        const declared = arenas.declaredArenas();
        expect(arenas.ARENA_BUILDS).toHaveLength(declared.length);
        for (const one of declared) {
            const build = format.arenaBuildSchema.parse(one.build);
            const { x, y, z } = build.size;
            expect(format.decodeCells(build)).toHaveLength(x * y * z);
            expect(Math.max(x, y, z)).toBeLessThanOrEqual(format.ARENA_SIDE_MAX);
            expect(arenas.contractProblems(build, one.contract), build.id).toEqual([]);
        }
    });

    it("has a build for every kind it offers, with that kind's contract", () => {
        for (const kind of arenas.ARENA_BUILD_KINDS) {
            const entries = arenas.arenaBuildsFor(kind);
            expect(entries.length, kind).toBeGreaterThan(0);
            for (const { contract } of entries) {
                expect(contract.kind).toBe(kind);
                if (contract.kind === "spleef" || contract.kind === "tnt-run") {
                    expect(contract.floors.length).toBeGreaterThan(0);
                    expect(contract.spawns.length).toBeGreaterThanOrEqual(4);
                }
                if (contract.kind === "king-of-the-hill") expect(contract.hill.radius).toBe(2);
                if (contract.kind === "team-duel")
                    expect(contract.teams.every((team) => team.length >= 2)).toBe(true);
                if (contract.kind === "hide-and-seek")
                    expect(contract.hiders.length).toBeGreaterThan(0);
            }
        }
        expect(arenas.arenaBuildsFor("parkour")).toEqual([]);
    });

    it("never ships a TNT run build with anything that powers redstone", () => {
        for (const { build } of arenas.arenaBuildsFor("tnt-run"))
            for (const state of build.palette)
                expect(arenas.POWER_SOURCES).not.toContain(format.blockOf(state));
    });

    it("finds a broken contract: a start in a wall, a floor that is not there", () => {
        const [entry] = arenas.arenaBuildsFor("spleef");
        if (entry?.contract.kind !== "spleef") throw new Error("no spleef build");
        const floor = entry.contract.floors[0]!;
        const sunk = {
            ...entry.contract,
            spawns: [{ ...entry.contract.spawns[0]!, y: floor.y }],
            floors: [{ ...floor, cells: floor.cells + 1 }]
        };
        const problems = arenas.contractProblems(entry.build, sunk);
        expect(problems.some((one) => one.includes("no footing"))).toBe(true);
        expect(problems.some((one) => one.includes("breakable cells"))).toBe(true);
    });

    it("draws a run's layout from its id: the generated arena or a build, always the same", () => {
        const drawn = Array.from({ length: 40 }, (_, at) =>
            arenas.arenaLayoutFor("spleef", `run-${at}`)
        );
        expect(drawn.some((one) => one === null)).toBe(true);
        expect(drawn.some((one) => one !== null)).toBe(true);
        expect(arenas.arenaLayoutFor("spleef", "run-7")).toBe(drawn[7]);
        expect(arenas.arenaLayoutFor("parkour", "run-7")).toBeNull();
    });

    it("moves a contract to where its build is pasted", () => {
        const [entry] = arenas.arenaBuildsFor("king-of-the-hill");
        const placed = arenas.contractAt(entry!.contract, { x: 100, y: 70, z: -50 });
        if (placed.kind !== "king-of-the-hill" || entry!.contract.kind !== "king-of-the-hill")
            throw new Error("not a hill");
        expect(placed.hill).toEqual({
            x: entry!.contract.hill.x + 100,
            y: entry!.contract.hill.y + 70,
            z: entry!.contract.hill.z - 50,
            radius: 2
        });
        expect(plan.pastePieces(entry!.build, { x: 100, y: 70, z: -50 }).length).toBeGreaterThan(0);
    });
});

describe("spleef and TNT run played on a build", () => {
    const floorEntries = arenas.ARENA_BUILDS.filter(
        (one) => one.contract.kind === "spleef" || one.contract.kind === "tnt-run"
    );
    const site = { x: 300, z: -40 };
    const y = 120;
    const corners = (line: string) =>
        / (?:setblock|fill) (-?\d+) (-?\d+) (-?\d+)(?: (-?\d+) (-?\d+) (-?\d+))? /
            .exec(line)!
            .slice(1)
            .filter((one) => one !== undefined)
            .map(Number);

    it("has a build for every floor game", () => {
        expect(floorEntries.map((one) => one.contract.kind).sort()).toEqual([
            "spleef",
            "spleef",
            "tnt-run",
            "tnt-run"
        ]);
    });

    it.each(floorEntries.map((one) => [one.build.id, one] as const))(
        "%s pastes inside the volume it proves, over a net that catches every fall",
        (_id, entry) => {
            const built = arenas.floorArena(entry, site, y);
            const { volume } = built.arena;
            const [net] = built.arena.boxes;
            expect(built.arena.boxes).toHaveLength(1);
            expect(net).toEqual({
                x1: volume.x1,
                y1: volume.y1,
                z1: volume.z1,
                x2: volume.x2,
                y2: volume.y1,
                z2: volume.z2,
                block: arenas.NET_BLOCK
            });
            for (const piece of built.paste) {
                expect(piece.line.endsWith(" keep")).toBe(true);
                const [x1, y1, z1, x2 = x1!, y2 = y1!, z2 = z1!] = corners(piece.line);
                for (const [low, high, from, to] of [
                    [volume.x1, volume.x2, x1!, x2],
                    [volume.y1, volume.y2, y1!, y2],
                    [volume.z1, volume.z2, z1!, z2]
                ] as const) {
                    expect(Math.min(from, to)).toBeGreaterThanOrEqual(low);
                    expect(Math.max(from, to)).toBeLessThanOrEqual(high);
                }
                // The net is under every block of the build, and reaches
                // past its every side, so a jump off an edge lands on it.
                expect(Math.min(y1!, y2)).toBeGreaterThan(net!.y1);
                expect(Math.min(x1!, x2)).toBeGreaterThanOrEqual(net!.x1 + arenas.NET_MARGIN);
                expect(Math.max(x1!, x2)).toBeLessThanOrEqual(net!.x2 - arenas.NET_MARGIN);
                expect(Math.min(z1!, z2)).toBeGreaterThanOrEqual(net!.z1 + arenas.NET_MARGIN);
                expect(Math.max(z1!, z2)).toBeLessThanOrEqual(net!.z2 - arenas.NET_MARGIN);
            }
            // Every start on the top floor, inside the square it closes in from.
            const { center, size, floor } = built.arena;
            for (const at of spleef.spots(built.arena, 12)) {
                expect(at.y).toBe(floor + 1);
                expect(Math.abs(at.x - 0.5 - center.x)).toBeLessThanOrEqual(size);
                expect(Math.abs(at.z - 0.5 - center.z)).toBeLessThanOrEqual(size);
            }
            // Out once under the last floor, over the net.
            expect(spleef.fell(built.arena, built.arena.floors.at(-1)! + 1)).toBe(false);
            expect(spleef.fell(built.arena, net!.y1 + 1)).toBe(true);
            // What the event pack is switched off by: the floors' low corner.
            const block = entry.contract.kind === "spleef" ? spleef.FLOOR : tntRun.FLOOR;
            expect(built.marks).toEqual(spleef.floorMarks(built.arena, block));
        }
    );

    it("marks a generated floor the way its own boxes did, so its pack stops as before", () => {
        const options = {
            place: { mode: "players" as const },
            size: 6,
            height: 30,
            variants: undefined
        };
        const generated = spleef.arena(options as never, site, y);
        const snow = generated.boxes.filter((one) => one.block === spleef.FLOOR);
        const low = (list: readonly { x1: number; y1: number; z1: number }[]) =>
            list.map((one) => [one.x1, one.y1, one.z1]).sort((a, b) => a[1]! - b[1]!);
        expect(low(spleef.floorMarks(generated, spleef.FLOOR))).toEqual(low(snow));
    });

    it("draws the layout from the run, and keeps the one it was placed with", () => {
        const ids = Array.from({ length: 60 }, (_, at) =>
            arenas.layoutIdFor("spleef", `run-${at}`)
        );
        expect(new Set(ids)).toEqual(new Set([null, "spleef-tower", "spleef-frozen-garden"]));
        expect(arenas.layoutIdFor("spleef", "run-7")).toBe(ids[7]);
        expect(arenas.layoutIdFor("parkour", "run-7")).toBeNull();
        expect(arenas.floorEntryOf("tnt-run", "spleef-tower")).toBeNull();

        const preset = {
            kind: "tnt-run",
            options: { place: { mode: "players" }, size: 6, height: 30, layers: 3 }
        };
        const placed = (layout: string | null) =>
            stageService.stageLayout(
                {
                    id: "run-1",
                    preset,
                    stage: { origin: { x: 300, y: 120, z: -40 }, layout, design: 1 }
                } as never,
                { x: 300, y: 120, z: -40 }
            );
        const tower = arenas.floorArena(arenas.floorEntryOf("tnt-run", "tnt-run-tower")!, site, y);
        expect(placed("tnt-run-tower").boxes).toEqual(tower.arena.boxes);
        expect(placed("tnt-run-tower").volume).toEqual(tower.arena.volume);
        // A run placed before builds were offered keeps its generated floors.
        expect(placed(null).boxes.some((one) => one.block === tntRun.FLOOR)).toBe(true);
    });
});
