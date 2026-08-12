/**
 * What building a server on a prebuilt map actually does.
 *
 * The failure this file guards is the one the maps exist to end: a server that
 * starts, looks like a server, and is not the game anybody asked for. It has three
 * shapes, and there is a test for each. The world never arrives, because nothing
 * told the container to fetch it. The world arrives and the game in it does
 * nothing, because the release moved out from under the commands it is written in.
 * Or the world arrives and a plugin fights it for the same game.
 *
 * The fourth is quieter and is here too: a server that keeps fetching a map after
 * it was reset onto something else, and one that keeps a map's resource pack after
 * the map is gone.
 */

import { isLevelName } from "@/lib/apps/minecraft/world";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blueprintFor, minecraftShapeEnv } from "@/lib/apps/games-create";
import { GAME_BLUEPRINTS, findBlueprint } from "@/lib/apps/minecraft/blueprints";
import { MAP_CATEGORIES, WORLD_MAPS, findMap, mapsFor } from "@/lib/apps/minecraft/maps";

/** Modrinth as these tests need it: enough for the version pin to resolve, since
 *  a map with no plugins asks it nothing and a blueprint without one still does. */
const RELEASES = ["1.21.6", "1.21.5", "1.21.4"];

beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/tag/game_version")) {
            return {
                ok: true,
                json: async () => RELEASES.map((version) => ({ version, version_type: "release" }))
            } as unknown as Response;
        }
        return {
            ok: true,
            json: async () => RELEASES.map((version) => ({ game_versions: [version], version_type: "release" }))
        } as unknown as Response;
    });
});

/** The environment a server built on this map would run with. */
async function envFor(
    blueprintId: string,
    mapId: string,
    extra: Record<string, string> = {},
    version = "LATEST"
): Promise<Map<string, string>> {
    return minecraftShapeEnv(
        "java",
        blueprintFor("java", blueprintId),
        { blueprintId, mapId, version, concurrentPlayers: 8, crossplay: false },
        new Map(Object.entries(extra))
    );
}

describe("the map catalog", () => {
    it("names an archive that can be fetched and identified", () => {
        for (const map of WORLD_MAPS) {
            expect(map.url, map.id).toMatch(/^https:\/\//);
            // The hash is what says the mirror still holds what this entry
            // describes. A short or absent one is a claim nobody can check.
            expect(map.sha256, map.id).toMatch(/^[0-9a-f]{64}$/);
            expect(map.bytes, map.id).toBeGreaterThan(0);
        }
    });

    it("uses an id the server can name a level folder with", () => {
        // The id is handed to the container as $LEVEL, so it has to survive being
        // a directory name and a command argument.
        for (const map of WORLD_MAPS) expect(isLevelName(map.id), map.id).toBe(true);
    });

    it("credits whoever built it", () => {
        for (const map of WORLD_MAPS) {
            expect(map.author.trim().length, map.id).toBeGreaterThan(0);
            expect(map.source, map.id).toMatch(/^https:\/\//);
        }
    });

    it("turns off spawn protection, which is the setting that silently breaks a built map", () => {
        // Sixteen blocks nobody but an operator can build in is a fence around a
        // generated spawn and is the middle of the game on every map here.
        for (const map of WORLD_MAPS) expect(map.env?.SPAWN_PROTECTION, map.id).toBe("0");
    });

    it("belongs to a category some blueprint can be built from", () => {
        for (const map of WORLD_MAPS) {
            expect(MAP_CATEGORIES[map.category], map.id).toBeTruthy();
            expect(
                GAME_BLUEPRINTS.some((blueprint) => blueprint.mapCategory === map.category),
                map.id
            ).toBe(true);
        }
    });

    it("offers every blueprint that claims a category at least one map", () => {
        // A blueprint whose picker has only "generate a world" on it is a category
        // that was named and never filled.
        for (const blueprint of GAME_BLUEPRINTS.filter((entry) => entry.mapCategory)) {
            expect(mapsFor(blueprint).length, blueprint.id).toBeGreaterThan(0);
        }
    });

    it("gives a pack a hash, because the game will not reuse one it cannot identify", () => {
        for (const map of WORLD_MAPS.filter((entry) => entry.resourcePack)) {
            expect(map.resourcePack?.sha1, map.id).toMatch(/^[0-9a-f]{40}$/);
        }
    });
});

describe("building a server on a map", () => {
    it("tells the container which world to fetch, and where to put it", async () => {
        const env = await envFor("bedwars", "bedwars-treasure-island");
        expect(env.get("WORLD")).toBe(findMap("bedwars-treasure-island")?.url);
        expect(env.get("LEVEL")).toBe("bedwars-treasure-island");
    });

    it("writes the world blank when there is no map, so a reset stops fetching one", async () => {
        // The variable is remembered by the container between starts. Left alone,
        // a server reset from a map onto plain survival downloads the map again on
        // its next restart and boots into it.
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "survival"),
            { blueprintId: "survival", version: "LATEST", concurrentPlayers: 8, crossplay: false },
            new Map([["WORLD", findMap("bedwars-treasure-island")?.url ?? ""]])
        );
        expect(env.get("WORLD")).toBe("");
    });

    it("pins the release a pinned map's own game was written for", async () => {
        // Asked for the newest, and given 1.19.4 anyway: the datapack declares that
        // release and a later server refuses to load it, which is a bed wars map
        // that is only a pretty island.
        const env = await envFor("bedwars", "bedwars-treasure-island");
        expect(env.get("VERSION")).toBe("1.19.4");
    });

    it("refuses a release a pinned map cannot play on", async () => {
        await expect(envFor("bedwars", "bedwars-treasure-island", {}, "1.21.4")).rejects.toThrow(
            /only plays on Minecraft 1\.19\.4/
        );
    });

    it("takes the newest release for a map that only brings terrain", async () => {
        // Skyblock 2.1 is a world and a chest, with no commands of its own to go
        // out of date, so nothing here should hold it to 1.16.
        const env = await envFor("skyblock", "skyblock-2-1");
        expect(env.get("VERSION")).toBe("LATEST");
    });

    it("takes the blueprint's plugin off, rather than running two of the same game", async () => {
        const env = await envFor("bedwars", "bedwars-treasure-island", {
            MODRINTH_PROJECTS: "grimac?:alpha,coreprotect?"
        });
        expect(env.get("MODRINTH_PROJECTS")).not.toContain("bedwars1058");
        // What was already there for every server stays there.
        expect(env.get("MODRINTH_PROJECTS")).toContain("coreprotect");
    });

    it("lets the map's settings win over the blueprint's", async () => {
        // The blueprint set the world flat and the mode for a plugin's lobby; the
        // map is the thing people will be standing in.
        const env = await envFor("parkour", "parkour-spiral");
        expect(env.get("MODE")).toBe("adventure");
        expect(env.get("SPAWN_PROTECTION")).toBe("0");
        expect(env.get("ENABLE_COMMAND_BLOCK")).toBe("true");
    });

    it("installs the pack a map needs, with the hash the game checks it by", async () => {
        const map = findMap("luckyblock-towers");
        const env = await envFor("luckyblock", "luckyblock-towers");
        expect(env.get("RESOURCE_PACK")).toBe(map?.resourcePack?.url);
        expect(env.get("RESOURCE_PACK_SHA1")).toBe(map?.resourcePack?.sha1);
    });

    it("clears a map's pack when the new map has none, and leaves anybody else's alone", async () => {
        const previous = findMap("luckyblock-towers")?.resourcePack?.url ?? "";
        const cleared = await envFor("skyblock", "skyblock-2-1", { RESOURCE_PACK: previous });
        expect(cleared.get("RESOURCE_PACK")).toBe("");

        // An operator who set their own under Settings did so deliberately, and a
        // change of map is not them asking for it to be removed.
        const kept = await envFor("skyblock", "skyblock-2-1", { RESOURCE_PACK: "https://example.test/mine.zip" });
        expect(kept.get("RESOURCE_PACK")).toBe("https://example.test/mine.zip");
    });

    it("refuses a map that is not this game's", async () => {
        await expect(envFor("skyblock", "bedwars-treasure-island")).rejects.toThrow(/not one this game/);
    });

    it("refuses a map nothing knows about", async () => {
        await expect(envFor("skyblock", "not-a-map")).rejects.toThrow(/not one this game/);
    });

    it("leaves a server with no map generating its own world", async () => {
        const blueprint = findBlueprint("survival");
        expect(mapsFor(blueprint).length).toBe(0);
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "survival"),
            { blueprintId: "survival", version: "LATEST", seed: "hello", concurrentPlayers: 8, crossplay: false },
            new Map()
        );
        expect(env.get("SEED")).toBe("hello");
        expect(env.get("WORLD")).toBe("");
    });
});
