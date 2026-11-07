/**
 * The Lucky blocks blueprint: a real lucky block game on a fresh server.
 *
 * It used to install nothing and lean on a map whose "lucky blocks" were sponges
 * wearing a resource pack, in adventure mode - so nothing could be broken and the
 * game was a climb. It now installs the Lucky Blocks datapack and its world
 * add-on through the image's own `datapack:` entries, which only works if every
 * reader of the project list here understands that prefix the way the image does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    entryLoader,
    forgetModrinthAnswers,
    projectSlug,
    repinEntry,
    splitEntry
} from "@polaris-app/game-servers/src/lib/minecraft/modrinth";
import { commonVersions } from "@polaris-app/game-servers/src/lib/minecraft/blueprint-version";
import {
    blueprintFor,
    minecraftShapeEnv,
    withoutBlueprintProjects
} from "@polaris-app/game-servers/src/lib/games-create";
import { findBlueprint } from "@polaris-app/game-servers/src/lib/minecraft/blueprints";

const RELEASES = ["26.3", "26.2", "26.1.2", "1.21.11"];

/** What each project has a build for, by loader and then by slug. */
let builds: Record<string, Record<string, string[]>>;
let asked: string[] = [];

beforeEach(() => {
    asked = [];
    forgetModrinthAnswers();
    builds = {
        datapack: {
            "ly-lucky-blocks": ["26.3", "26.2", "26.1.2", "1.21.11"],
            "lucky-blocks-world": ["26.3", "26.2", "26.1.2"]
        },
        // Neither project publishes a Paper build, which is exactly why a lookup
        // that ignored the prefix found nothing to pin.
        paper: {}
    };
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        if (url.includes("/tag/game_version")) {
            return {
                ok: true,
                json: async () => RELEASES.map((version) => ({ version, version_type: "release" }))
            } as unknown as Response;
        }
        const slug = (url.split("/project/")[1] ?? "").split("/")[0] ?? "";
        const loaders = decodeURIComponent(url.split("loaders=")[1]?.split("&")[0] ?? "[]");
        const loader = (JSON.parse(loaders) as string[])[0] ?? "";
        return {
            ok: true,
            json: async () =>
                (builds[loader]?.[slug] ?? []).map((version) => ({
                    game_versions: [version],
                    version_type: "release"
                }))
        } as unknown as Response;
    });
});

async function envFor(blueprintId: string, mapId?: string): Promise<Map<string, string>> {
    return minecraftShapeEnv(
        "java",
        blueprintFor("java", blueprintId),
        { blueprintId, mapId, version: "LATEST", concurrentPlayers: 8, crossplay: false },
        new Map()
    );
}

describe("a project entry with a loader in front", () => {
    it("is read as the project, installed with that loader", () => {
        expect(splitEntry("datapack:ly-lucky-blocks")).toEqual({
            slug: "ly-lucky-blocks",
            optional: false,
            parts: [],
            loader: "datapack"
        });
        expect(projectSlug("datapack:lucky-blocks-world")).toBe("lucky-blocks-world");
        expect(splitEntry("fabric:pl3xmap?:beta")).toMatchObject({
            slug: "pl3xmap",
            optional: true,
            parts: ["beta"],
            loader: "fabric"
        });
    });

    it("leaves an entry with no loader exactly as it was read before", () => {
        expect(splitEntry("bedwars1058:beta")).toEqual({
            slug: "bedwars1058",
            optional: false,
            parts: ["beta"],
            loader: null
        });
        // A version is not a loader just because it follows the same colon.
        expect(splitEntry("grimac?:2.3.70").loader).toBeNull();
        expect(entryLoader("geyser", "paper")).toBe("paper");
        expect(entryLoader("datapack:terralith", "paper")).toBe("datapack");
    });

    it("keeps its loader when it is pinned to another build", () => {
        expect(repinEntry("datapack:ly-lucky-blocks", "1.3.3")).toBe(
            "datapack:ly-lucky-blocks:1.3.3"
        );
        expect(repinEntry("bedwars1058:beta", "25.3")).toBe("bedwars1058:beta:25.3");
    });
});

describe("the Lucky blocks blueprint", () => {
    it("installs the lucky block datapacks, required", () => {
        const lucky = findBlueprint("luckyblock");
        expect(lucky?.projects).toEqual([
            "datapack:ly-lucky-blocks",
            "datapack:lucky-blocks-world"
        ]);
        expect(lucky?.docs).toBe("https://modrinth.com/datapack/ly-lucky-blocks");
    });

    it("pins a release both datapacks have a datapack build for", async () => {
        expect(
            await commonVersions(["datapack:ly-lucky-blocks", "datapack:lucky-blocks-world"])
        ).toEqual(["26.3", "26.2", "26.1.2"]);
        const env = await envFor("luckyblock");
        expect(env.get("VERSION")).toBe("26.3");
        expect(asked.some((url) => url.includes("datapack"))).toBe(true);
    });

    it("hands the image the datapacks to download, on a survival world people can break", async () => {
        const env = await envFor("luckyblock");
        const projects = (env.get("MODRINTH_PROJECTS") ?? "").split(",");
        expect(projects).toContain("datapack:ly-lucky-blocks");
        expect(projects).toContain("datapack:lucky-blocks-world");
        expect(env.get("MODE")).toBe("survival");
        expect(env.get("PVP")).toBe("true");
        // The world add-on places lucky blocks as a structure, which a flat lobby
        // would never generate.
        expect(env.get("LEVEL_TYPE")).toBe("minecraft:normal");
    });

    it("takes the datapacks back off when the server is reset onto another game", () => {
        expect(
            withoutBlueprintProjects("datapack:ly-lucky-blocks,datapack:lucky-blocks-world,chunky")
        ).toBe("chunky");
    });
});
