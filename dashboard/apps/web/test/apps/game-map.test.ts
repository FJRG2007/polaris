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

import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isLevelName } from "@polaris-app/game-servers/src/lib/minecraft/world";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blueprintFor, minecraftShapeEnv } from "@polaris-app/game-servers/src/lib/games-create";
import {
    GAME_BLUEPRINTS,
    findBlueprint
} from "@polaris-app/game-servers/src/lib/minecraft/blueprints";
import {
    MAP_CATEGORIES,
    WORLD_MAPS,
    findMap,
    mapUrlRewrites,
    mapsFor,
    type MapAddresses
} from "@polaris-app/game-servers/src/lib/minecraft/maps";
import { renderWorldEdge } from "@polaris-app/game-servers/src/lib/minecraft/world-address";
import { rejection } from "../setup/game-english";

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
            json: async () =>
                RELEASES.map((version) => ({ game_versions: [version], version_type: "release" }))
        } as unknown as Response;
    });
});

/** Where the archives are served from on an instance with a public address. */
const PUBLIC: MapAddresses = {
    world: "https://polaris.example",
    pack: "https://polaris.example",
    key: "key"
};

/** And on one without: the world through the edge inside the network, no pack. */
const LOCAL: MapAddresses = { world: "http://traefik", pack: null, key: "key" };

/** The archives as the repository carries them. */
const WORLDS_DIR = join(__dirname, "..", "..", "..", "..", "resources", "minecraft-worlds");

/** The environment a server built on this map would run with. */
async function envFor(
    blueprintId: string,
    mapId: string,
    extra: Record<string, string> = {},
    version = "LATEST",
    addresses: MapAddresses = PUBLIC
): Promise<Map<string, string>> {
    return minecraftShapeEnv(
        "java",
        blueprintFor("java", blueprintId),
        { blueprintId, mapId, version, concurrentPlayers: 8, crossplay: false },
        new Map(Object.entries(extra)),
        addresses
    );
}

describe("the map catalog", () => {
    it("names an archive Polaris carries, by its hash and size", () => {
        // The hash is what says the file shipped is the one this entry describes.
        for (const map of WORLD_MAPS) {
            const bytes = readFileSync(join(WORLDS_DIR, map.archive));
            expect(createHash("sha256").update(bytes).digest("hex"), map.id).toBe(map.sha256);
            expect(bytes.length, map.id).toBe(map.bytes);
        }
    });

    it("gives a pack the hash of the file Polaris carries", () => {
        // The game checks the pack it downloaded against this, and refuses one
        // that does not match.
        for (const map of WORLD_MAPS.filter((entry) => entry.resourcePack)) {
            const bytes = readFileSync(join(WORLDS_DIR, map.resourcePack!.archive));
            expect(createHash("sha1").update(bytes).digest("hex"), map.id).toBe(
                map.resourcePack!.sha1
            );
        }
    });

    it("carries no archive no map names", () => {
        const named = new Set(
            WORLD_MAPS.flatMap((map) => [
                map.archive,
                ...(map.resourcePack ? [map.resourcePack.archive] : [])
            ])
        );
        for (const file of readdirSync(WORLDS_DIR).filter((name) => name.endsWith(".zip")))
            expect(named.has(file), file).toBe(true);
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
        expect(env.get("WORLD")).toBe(
            "https://polaris.example/api/minecraft/world/key/bedwars-treasure-island.zip"
        );
        expect(env.get("LEVEL")).toBe("bedwars-treasure-island");
    });

    it("fetches the world through the edge inside the network when there is no public address", async () => {
        // `polaris.local` does not resolve inside a container; the edge's own
        // name on the proxy network does.
        const env = await envFor("bedwars", "bedwars-treasure-island", {}, "LATEST", LOCAL);
        expect(env.get("WORLD")).toBe(
            "http://traefik/api/minecraft/world/key/bedwars-treasure-island.zip"
        );
    });

    it("writes the world blank when there is no map, so a reset stops fetching one", async () => {
        // The variable is remembered by the container between starts. Left alone,
        // a server reset from a map onto plain survival downloads the map again on
        // its next restart and boots into it.
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "survival"),
            { blueprintId: "survival", version: "LATEST", concurrentPlayers: 8, crossplay: false },
            new Map([
                [
                    "WORLD",
                    "https://polaris.example/api/minecraft/world/key/bedwars-treasure-island.zip"
                ]
            ]),
            PUBLIC
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
        expect(await rejection(envFor("bedwars", "bedwars-treasure-island", {}, "1.21.4"))).toMatch(
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
        expect(env.get("RESOURCE_PACK")).toBe(
            "https://polaris.example/api/minecraft/map-pack/luckyblock-towers-resources.zip"
        );
        expect(env.get("RESOURCE_PACK_SHA1")).toBe(map?.resourcePack?.sha1);
    });

    it("writes no pack when no client could reach one", async () => {
        const env = await envFor("luckyblock", "luckyblock-towers", {}, "LATEST", LOCAL);
        expect(env.get("RESOURCE_PACK") ?? "").toBe("");
        expect(env.get("WORLD")).toBe(
            "http://traefik/api/minecraft/world/key/luckyblock-towers.zip"
        );
    });

    it("clears a map's pack when the new map has none, and leaves anybody else's alone", async () => {
        const previous =
            "https://polaris.example/api/minecraft/map-pack/luckyblock-towers-resources.zip";
        const cleared = await envFor("skyblock", "skyblock-2-1", { RESOURCE_PACK: previous });
        expect(cleared.get("RESOURCE_PACK")).toBe("");

        // An operator who set their own under Settings did so deliberately, and a
        // change of map is not them asking for it to be removed.
        const kept = await envFor("skyblock", "skyblock-2-1", {
            RESOURCE_PACK: "https://example.test/mine.zip"
        });
        expect(kept.get("RESOURCE_PACK")).toBe("https://example.test/mine.zip");
    });

    it("refuses a map that is not this game's", async () => {
        expect(await rejection(envFor("skyblock", "bedwars-treasure-island"))).toMatch(
            /not one this game/
        );
    });

    it("refuses a map nothing knows about", async () => {
        expect(await rejection(envFor("skyblock", "not-a-map"))).toMatch(/not one this game/);
    });

    it("puts the world shape back to its default, rather than leaving the old one", async () => {
        // Not the same as not writing it. A blueprint's flat lobby setting already
        // on the server means `level-type=minecraft:flat` with no layers under it,
        // which the server reports as an error on every boot of a world it will
        // never generate - and skipping the write left exactly that in place, so
        // the error outlived the change meant to stop it.
        const env = await envFor("bedwars", "bedwars-treasure-island", {
            LEVEL_TYPE: "minecraft:flat",
            GENERATOR_SETTINGS: "",
            SEED: "12345"
        });
        expect(env.get("LEVEL_TYPE")).toBe("minecraft:normal");
        expect(env.get("SEED")).toBe("");
    });

    it("generates the world the map was built on, for one too old to say so itself", async () => {
        // Minecraft only started storing world generation in the world file in
        // 1.16. Lucky blocks predates that, so the server reads its own level-type
        // instead - and the default grew ordinary terrain up through a map built in
        // the void, leaving the map's own spawn point buried under a hillside. It
        // looked exactly like the map had never been installed.
        const env = await envFor("luckyblock", "luckyblock-towers");
        expect(env.get("LEVEL_TYPE")).toBe("minecraft:flat");
        expect(JSON.parse(env.get("GENERATOR_SETTINGS") ?? "{}")).toEqual({
            layers: [{ block: "minecraft:air", height: 1 }],
            biome: "minecraft:desert"
        });
    });

    it("says nothing about generation for a map that carries its own", async () => {
        // Every map from 1.16 on describes itself, and the server reads it out of
        // the world. Writing a shape here would be describing terrain that exists.
        const env = await envFor("bedwars", "bedwars-treasure-island");
        expect(env.get("LEVEL_TYPE")).toBe("minecraft:normal");
        expect(env.get("GENERATOR_SETTINGS")).toBe("");
    });

    it("leaves a server with no map generating its own world", async () => {
        const blueprint = findBlueprint("survival");
        expect(mapsFor(blueprint).length).toBe(0);
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "survival"),
            {
                blueprintId: "survival",
                version: "LATEST",
                seed: "hello",
                concurrentPlayers: 8,
                crossplay: false
            },
            new Map()
        );
        expect(env.get("SEED")).toBe("hello");
        expect(env.get("WORLD")).toBe("");
    });
});

describe("moving a server's map to where Polaris serves it", () => {
    const FORMER = "https://cdn.jsdelivr.net/gh/former/worlds@v4";

    it("moves a world and a pack from where they used to come from", () => {
        const env = new Map([
            ["WORLD", `${FORMER}/luckyblock-towers.zip`],
            ["RESOURCE_PACK", `${FORMER}/luckyblock-towers-resources.zip`]
        ]);
        expect(mapUrlRewrites(env, PUBLIC)).toEqual({
            WORLD: "https://polaris.example/api/minecraft/world/key/luckyblock-towers.zip",
            RESOURCE_PACK:
                "https://polaris.example/api/minecraft/map-pack/luckyblock-towers-resources.zip",
            RESOURCE_PACK_SHA1: findMap("luckyblock-towers")?.resourcePack?.sha1
        });
    });

    it("follows a rotated key and a changed address, and clears a pack nobody can reach", () => {
        const env = new Map([
            ["WORLD", "https://old.example/api/minecraft/world/stale/skyblock-2-1.zip"],
            [
                "RESOURCE_PACK",
                "https://old.example/api/minecraft/map-pack/luckyblock-towers-resources.zip"
            ]
        ]);
        expect(mapUrlRewrites(env, LOCAL)).toEqual({
            WORLD: "http://traefik/api/minecraft/world/key/skyblock-2-1.zip",
            RESOURCE_PACK: "",
            RESOURCE_PACK_SHA1: ""
        });
    });

    it("gives a cleared pack back once the instance has an address a client can reach", () => {
        const env = new Map([
            ["WORLD", "http://traefik/api/minecraft/world/key/luckyblock-towers.zip"],
            ["RESOURCE_PACK", ""],
            ["RESOURCE_PACK_SHA1", ""]
        ]);
        expect(mapUrlRewrites(env, LOCAL)).toEqual({});
        expect(mapUrlRewrites(env, PUBLIC)).toEqual({
            WORLD: "https://polaris.example/api/minecraft/world/key/luckyblock-towers.zip",
            RESOURCE_PACK:
                "https://polaris.example/api/minecraft/map-pack/luckyblock-towers-resources.zip",
            RESOURCE_PACK_SHA1: findMap("luckyblock-towers")?.resourcePack?.sha1
        });
    });

    it("changes nothing already right, and nothing somebody else set", () => {
        expect(
            mapUrlRewrites(
                new Map([
                    ["WORLD", "https://polaris.example/api/minecraft/world/key/skyblock-2-1.zip"]
                ]),
                PUBLIC
            )
        ).toEqual({});
        expect(
            mapUrlRewrites(
                new Map([
                    ["WORLD", "https://example.test/my-world.zip"],
                    ["RESOURCE_PACK", "https://example.test/skyblock-2-1.zip"]
                ]),
                PUBLIC
            )
        ).toEqual({});
    });
});

describe("the edge route a world is fetched through without a public address", () => {
    it("routes the world path on the edge's internal name to the dashboard, on plain HTTP", () => {
        expect(renderWorldEdge("traefik", "http://web:3000")).toBe(
            [
                "http:",
                "  routers:",
                "    polaris-game-servers-worlds:",
                '      rule: "Host(`traefik`) && PathPrefix(`/api/minecraft/world/`)"',
                "      entryPoints: [web]",
                "      priority: 100",
                "      service: polaris-game-servers-worlds",
                "  services:",
                "    polaris-game-servers-worlds:",
                "      loadBalancer:",
                "        servers:",
                '          - url: "http://web:3000"',
                ""
            ].join("\n")
        );
    });

    it("publishes nothing for a name or an origin that is not plainly one", () => {
        expect(renderWorldEdge("traefik`) || Host(`x", "http://web:3000")).toBe("http: {}\n");
        expect(renderWorldEdge("traefik", 'http://web:3000"\n  evil: 1')).toBe("http: {}\n");
    });
});
