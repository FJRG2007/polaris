/**
 * The repair for a Paper 26 world whose Nether or End was imported without its
 * generation settings. Run for real against a folder on disk, because the whole
 * of it is a shell script and a script is only as right as what it did.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as world from "@polaris-app/game-servers/src/lib/minecraft/world";
import { crashAdvice, isWorldGenSettingsCrash } from "@polaris-app/game-servers/src/lib/crash-loop";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(path: string, body = "x"): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
}

/** The script run on a scratch data directory, as the container would. */
function repair(data: string, level: string): string {
    const argv = world.dimensionRepairArgv(level);
    const target = argv[4]!.replace(world.DATA_DIR, data.split(String.fromCharCode(92)).join("/"));
    return execFileSync(argv[0]!, [argv[1]!, argv[2]!, argv[3]!, target], { encoding: "utf8" });
}

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "polaris-dims-"));
    roots.push(root);
    return root;
}

const NETHER_SETTINGS = "dimensions/minecraft/the_nether/data/minecraft/world_gen_settings.dat";

describe("dimension repair", () => {
    it("passes the level as an argument, never inside the script", () => {
        const argv = world.dimensionRepairArgv("world-20261107-203624");
        expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(argv[2]).not.toContain("world-20261107-203624");
        expect(argv[4]).toBe("/data/world-20261107-203624");
    });

    it("puts back a Nether and End the image moved beside the level", () => {
        const data = scratch();
        const level = "world-20261107-203624";
        put(join(data, level, "level.dat"));
        put(join(data, `${level}_nether`, "DIM-1", "region", "r.0.0.mca"), "nether");
        put(join(data, `${level}_the_end`, "DIM1", "data", "raids.dat"));

        expect(world.dimensionsRepaired(repair(data, level))).toBe(true);
        expect(readFileSync(join(data, level, "DIM-1", "region", "r.0.0.mca"), "utf8")).toBe(
            "nether"
        );
        expect(existsSync(join(data, level, "DIM1", "data", "raids.dat"))).toBe(true);
        expect(existsSync(join(data, `${level}_nether`))).toBe(false);
        expect(existsSync(join(data, `${level}_the_end`))).toBe(false);
    });

    it("leaves a Nether CraftBukkit wrote, which Paper imports itself", () => {
        const data = scratch();
        put(join(data, "world", "level.dat"));
        put(join(data, "world_nether", "level.dat"));
        put(join(data, "world_nether", "DIM-1", "region", "r.0.0.mca"));

        expect(world.dimensionsRepaired(repair(data, "world"))).toBe(false);
        expect(existsSync(join(data, "world_nether", "DIM-1", "region", "r.0.0.mca"))).toBe(true);
        expect(existsSync(join(data, "world", "DIM-1"))).toBe(false);
    });

    it("gives an imported dimension the overworld's settings, once", () => {
        const data = scratch();
        const level = "world-20261107-203624";
        put(join(data, level, "level.dat"));
        put(
            join(
                data,
                level,
                "dimensions/minecraft/overworld/data/minecraft/world_gen_settings.dat"
            ),
            "settings"
        );
        put(join(data, level, "dimensions/minecraft/the_nether/region/r.0.0.mca"));
        put(join(data, level, "dimensions/minecraft/the_end/data/paper/metadata.dat"));

        expect(world.dimensionsRepaired(repair(data, level))).toBe(true);
        expect(readFileSync(join(data, level, NETHER_SETTINGS), "utf8")).toBe("settings");
        expect(
            existsSync(
                join(
                    data,
                    level,
                    "dimensions/minecraft/the_end/data/minecraft/world_gen_settings.dat"
                )
            )
        ).toBe(true);
        // Nothing left to do the second time, so a healthy boot is never touched.
        expect(world.dimensionsRepaired(repair(data, level))).toBe(false);
    });

    it("reads the settings a vanilla world keeps at its root", () => {
        const data = scratch();
        put(join(data, "parkour-spiral", "level.dat"));
        put(join(data, "parkour-spiral", "data/minecraft/world_gen_settings.dat"), "root");
        put(join(data, "parkour-spiral", "dimensions/minecraft/the_nether/region/r.0.0.mca"));

        expect(world.dimensionsRepaired(repair(data, "parkour-spiral"))).toBe(true);
        expect(readFileSync(join(data, "parkour-spiral", NETHER_SETTINGS), "utf8")).toBe("root");
    });

    it("changes nothing when there is no copy to give", () => {
        const data = scratch();
        put(join(data, "world", "level.dat"));
        put(join(data, "world", "dimensions/minecraft/the_nether/region/r.0.0.mca"));
        expect(world.dimensionsRepaired(repair(data, "world"))).toBe(false);
        expect(existsSync(join(data, "world", NETHER_SETTINGS))).toBe(false);
    });
});

describe("the crash it answers", () => {
    const line =
        "java.lang.IllegalStateException: Unable to read or access the world gen settings file for dimension minecraft:the_nether. ./world-20261107-203624/dimensions/minecraft/the_nether/data/minecraft/world_gen_settings.dat";

    it("is recognised from the line Paper prints", () => {
        expect(isWorldGenSettingsCrash(line)).toBe(true);
        expect(isWorldGenSettingsCrash("java.lang.OutOfMemoryError: Java heap space")).toBe(false);
        expect(isWorldGenSettingsCrash(null)).toBe(false);
    });

    it("has advice of its own", () => {
        expect(crashAdvice(line)).toContain("lib.crash.worldGenSettings");
    });
});
