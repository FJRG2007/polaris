/**
 * The rules the world feature rests on: which folders a level is made of, which
 * names may be handed to a command, how an archive is named and read back, and
 * where an unpacked backup has to land.
 *
 * These are the pure half on purpose - everything destructive in world-service
 * decides what to do from exactly these answers, so a wrong one here is a world
 * deleted or a restore written over the map somebody is playing on.
 */

import { describe, expect, it } from "vitest";
import * as world from "@/lib/apps/minecraft/world";

describe("level names", () => {
    it("accepts the names both editions actually use", () => {
        expect(world.isLevelName("world")).toBe(true);
        expect(world.isLevelName("Bedrock level")).toBe(true);
        expect(world.isLevelName("world-20260808-214530")).toBe(true);
    });

    it("refuses a name that would be read as a flag, hide the folder, or leave it", () => {
        expect(world.isLevelName("-rf")).toBe(false);
        expect(world.isLevelName(".hidden")).toBe(false);
        expect(world.isLevelName("../etc")).toBe(false);
        expect(world.isLevelName("world/nether")).toBe(false);
        expect(world.isLevelName("")).toBe(false);
        expect(world.isLevelName("a".repeat(65))).toBe(false);
    });
});

describe("seeds", () => {
    it("takes a number or any words, since the game hashes anything else", () => {
        expect(world.isSeed("-4172144997902289642")).toBe(true);
        expect(world.isSeed("glacier bay")).toBe(true);
    });

    it("refuses control characters and anything past the bound", () => {
        expect(world.isSeed("")).toBe(false);
        expect(world.isSeed("two\nlines")).toBe(false);
        expect(world.isSeed("x".repeat(65))).toBe(false);
    });
});

describe("archive names", () => {
    it("round-trips the moment a backup was taken", () => {
        const at = new Date("2026-08-08T21:45:30.123Z");
        const name = world.backupName(at);
        expect(name).toBe("2026-08-08T21-45-30-123.tar.gz");
        expect(world.backupTakenAt(name)?.toISOString()).toBe(at.toISOString());
    });

    it("refuses anything else that turns up in the folder", () => {
        expect(world.isBackupName("../../etc/passwd")).toBe(false);
        expect(world.isBackupName("world.tar.gz")).toBe(false);
        expect(world.isBackupName("2026-08-08T21-45-30-123.tar.gz.txt")).toBe(false);
        expect(world.backupTakenAt("nonsense.tar.gz")).toBeNull();
    });
});

describe("new level names", () => {
    it("stamps the name so two worlds never share a folder", () => {
        const name = world.newLevelName(new Date("2026-08-08T21:45:30.000Z"));
        expect(name).toBe("world-20260808-214530");
        expect(world.isLevelName(name)).toBe(true);
    });

    it("steps past a name that is already on disk", () => {
        const taken = ["world", "world-20260808-214530"];
        expect(world.newLevelName(new Date("2026-08-08T21:45:30.000Z"), taken)).toBe("world-20260808-214530-2");
    });
});

describe("level folders", () => {
    it("names all three Java dimensions and the one Bedrock directory", () => {
        expect(world.levelDirs("java", "world")).toEqual(["world", "world_nether", "world_the_end"]);
        expect(world.levelDirs("bedrock", "Bedrock level")).toEqual(["worlds/Bedrock level"]);
    });

    it("looks for the marker the game writes, under the edition's own directory", () => {
        expect(world.levelMarkerArgv("java")).toEqual([
            "find",
            "/data",
            "-mindepth",
            "2",
            "-maxdepth",
            "2",
            "-name",
            "level.dat"
        ]);
        expect(world.levelMarkerArgv("bedrock")[1]).toBe("/data/worlds");
    });

    it("lists a level once, not once per dimension", () => {
        const found = [
            "/data/world/level.dat",
            "/data/world_nether/level.dat",
            "/data/world_the_end/level.dat",
            "/data/world-20260101-000000/level.dat"
        ].join("\n");
        expect(world.levelsFromMarkers("java", found)).toEqual(["world", "world-20260101-000000"]);
    });

    it("never offers a folder the image keeps beside the world", () => {
        // logs, plugins and the rest hold no marker, so they never reach the list -
        // which is the whole reason the marker decides this and a name list does not.
        expect(world.levelsFromMarkers("java", "/data/world/level.dat")).toEqual(["world"]);
        expect(world.levelsFromMarkers("java", "")).toEqual([]);
    });

    it("reads a Bedrock level out of the worlds directory", () => {
        expect(world.levelsFromMarkers("bedrock", "/data/worlds/Bedrock level/level.dat")).toEqual(["Bedrock level"]);
    });
});

describe("restore plan", () => {
    it("renames every dimension onto the new level, not just the overworld", () => {
        const plan = world.restorePlan("java", ["world", "world_nether", "world_the_end"], "world-20260808-214530");
        expect(plan).toEqual([
            { from: "world", to: "world-20260808-214530" },
            { from: "world_nether", to: "world-20260808-214530_nether" },
            { from: "world_the_end", to: "world-20260808-214530_the_end" }
        ]);
    });

    it("handles an archive taken from a level that was not called world", () => {
        const plan = world.restorePlan("java", ["survival", "survival_nether"], "world-20260808-214530");
        expect(plan).toEqual([
            { from: "survival", to: "world-20260808-214530" },
            { from: "survival_nether", to: "world-20260808-214530_nether" }
        ]);
    });

    it("takes the one level a Bedrock archive holds", () => {
        expect(world.restorePlan("bedrock", ["Bedrock level"], "world-20260808-214530")).toEqual([
            { from: "Bedrock level", to: "world-20260808-214530" }
        ]);
    });

    it("plans nothing for an archive that holds no world", () => {
        expect(world.restorePlan("java", [], "world-1")).toEqual([]);
        expect(world.restorePlan("java", ["-rf"], "world-1")).toEqual([]);
    });
});

describe("reading what the container said", () => {
    it("puts each du figure against the folder it was asked about", () => {
        const sizes = world.parseDuLines("1024\t/data/world\n2048\t/data/world_nether\n");
        expect(sizes.get("/data/world")).toBe(1024 * 1024);
        expect(sizes.get("/data/world_nether")).toBe(2048 * 1024);
    });

    it("reads archives newest first and drops anything that is not one", () => {
        const rows = world.parseBackupList(
            [
                "512 /data/backups/2026-08-01T10-00-00-000.tar.gz",
                "1024 /data/backups/2026-08-08T21-45-30-123.tar.gz",
                "99 /data/backups/notes.txt"
            ].join("\n")
        );
        expect(rows.map((row) => row.name)).toEqual([
            "2026-08-08T21-45-30-123.tar.gz",
            "2026-08-01T10-00-00-000.tar.gz"
        ]);
        expect(rows[0]?.sizeBytes).toBe(1024);
    });

    it("reads a listing without its blank lines", () => {
        expect(world.parseListing("world\n\nworld_nether\n")).toEqual(["world", "world_nether"]);
    });
});

describe("what carries onto a new map", () => {
    it("carries a Java player's things and says Bedrock cannot", () => {
        expect(world.canCarryPlayers("java")).toBe(true);
        expect(world.canCarryPlayers("bedrock")).toBe(false);
        expect(world.PLAYER_DATA_DIRS).toContain("playerdata");
    });

    it("names the variables each edition reads the level and the seed from", () => {
        expect(world.levelEnvKey("java")).toBe("LEVEL");
        expect(world.levelEnvKey("bedrock")).toBe("LEVEL_NAME");
        expect(world.seedEnvKey("java")).toBe("SEED");
        expect(world.seedEnvKey("bedrock")).toBe("LEVEL_SEED");
    });
});
