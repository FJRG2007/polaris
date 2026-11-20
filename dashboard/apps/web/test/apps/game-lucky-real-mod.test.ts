/**
 * The lucky block games on the real mod: Lucky Block Challenge's worlds out of
 * its modpack, Lucky OneBlock on MyLuckyBlock, and ManojTheReaper's race, each
 * a blueprint that settles its own software, release and world.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetModrinthAnswers } from "@polaris-app/game-servers/src/lib/minecraft/modrinth";
import { blueprintFor, minecraftShapeEnv } from "@polaris-app/game-servers/src/lib/games-create";
import {
    blueprintsFor,
    curseforgeFileUrl,
    findBlueprint,
    LUCKY_CHALLENGE,
    releaseFor
} from "@polaris-app/game-servers/src/lib/minecraft/blueprints";
import { isLevelName } from "@polaris-app/game-servers/src/lib/minecraft/world";

const CHALLENGE = [
    ["lucky-challenge-race", "Race"],
    ["lucky-challenge-pillars", "Lucky Pillars"],
    ["lucky-challenge-oneblock", "OneBlock"],
    ["lucky-challenge-games", "Games"]
] as const;

/** What each project has a build for, by loader and then by slug. */
const BUILDS: Record<string, Record<string, string[]>> = {
    fabric: { myluckyblock: ["26.3", "26.2"] }
};

beforeEach(() => {
    forgetModrinthAnswers();
    vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/tag/game_version")) {
            return {
                ok: true,
                json: async () =>
                    ["26.3", "26.2", "1.21.1"].map((version) => ({
                        version,
                        version_type: "release"
                    }))
            } as unknown as Response;
        }
        const slug = (url.split("/project/")[1] ?? "").split("/")[0] ?? "";
        const loaders = decodeURIComponent(url.split("loaders=")[1]?.split("&")[0] ?? "[]");
        const loader = (JSON.parse(loaders) as string[])[0] ?? "";
        return {
            ok: true,
            json: async () =>
                (BUILDS[loader]?.[slug] ?? []).map((version) => ({
                    game_versions: [version],
                    version_type: "release"
                }))
        } as unknown as Response;
    });
});

async function envFor(blueprintId: string, version = "LATEST"): Promise<Map<string, string>> {
    return minecraftShapeEnv(
        "java",
        blueprintFor("java", blueprintId),
        { blueprintId, version, concurrentPlayers: 4, crossplay: false },
        new Map()
    );
}

describe("the create list", () => {
    it("offers the real-mod lucky block games and not the data-pack imitations", () => {
        const offered = blueprintsFor("java").map((blueprint) => blueprint.id);
        for (const [id] of CHALLENGE) expect(offered).toContain(id);
        expect(offered).toContain("lucky-oneblock");
        expect(offered).toContain("lucky-race-manoj");
        expect(offered).not.toContain("luckyrace");
        expect(offered).not.toContain("luckyblock");
    });

    it("still knows the retired blueprints, for the servers built from them", () => {
        expect(findBlueprint("luckyrace")?.retired).toBe(true);
        expect(findBlueprint("luckyblock")?.retired).toBe(true);
        expect(blueprintFor("java", "luckyrace").id).toBe("luckyrace");
    });
});

describe("Lucky Block Challenge", () => {
    it("pins the modpack to one version page on Modrinth", () => {
        expect(LUCKY_CHALLENGE.pack).toBe(
            "https://modrinth.com/modpack/lucky-block-challenge/version/2.1.2"
        );
        expect(LUCKY_CHALLENGE.release).toBe("1.21.1");
    });

    it.each(CHALLENGE)("%s installs the pack and starts on its %s world", async (id, world) => {
        const blueprint = findBlueprint(id);
        expect(blueprint?.software).toBe("MODRINTH");
        expect(blueprint?.projects).toEqual([]);
        expect(blueprint?.clientPack?.url).toBe(LUCKY_CHALLENGE.page);
        expect(releaseFor(blueprint, undefined)).toBe("1.21.1");
        const env = await envFor(id);
        expect(env.get("TYPE")).toBe("MODRINTH");
        expect(env.get("MODRINTH_MODPACK")).toBe(LUCKY_CHALLENGE.pack);
        expect(env.get("VERSION")).toBe("1.21.1");
        expect(env.get("WORLD")).toBe(`/data/saves/Lucky Block Challenge ${world}`);
        // A level name the rest of Polaris reads back, not a path into saves.
        expect(isLevelName(env.get("LEVEL") ?? "")).toBe(true);
        expect(env.get("LEVEL")).toBe(id);
    });

    it("refuses a release the pack is not built for", async () => {
        await expect(envFor("lucky-challenge-race", "26.3")).rejects.toThrow();
    });

    it("leaves the plugin list alone, because the pack brings its own mods", async () => {
        const env = await envFor("lucky-challenge-race");
        expect(env.get("MODRINTH_PROJECTS") ?? "").not.toMatch(/open-parties-and-claims/);
    });
});

describe("Lucky OneBlock", () => {
    it("runs Fabric 26.2 with MyLuckyBlock and the CurseForge world", async () => {
        const env = await envFor("lucky-oneblock");
        expect(env.get("TYPE")).toBe("FABRIC");
        expect(env.get("VERSION")).toBe("26.2");
        expect((env.get("MODRINTH_PROJECTS") ?? "").split(",")).toContain("myluckyblock");
        expect(env.get("WORLD")).toBe(
            "https://www.curseforge.com/api/v1/mods/872580/files/8550497/download"
        );
        expect(env.get("SPAWN_PROTECTION")).toBe("0");
        expect(env.get("MODRINTH_MODPACK")).toBe("");
        expect(findBlueprint("lucky-oneblock")?.clientPack?.url).toBe(
            "https://modrinth.com/mod/myluckyblock"
        );
    });
});

describe("ManojTheReaper's race", () => {
    it("is a data-pack map on 1.21.1 that needs no client mod", async () => {
        const blueprint = findBlueprint("lucky-race-manoj");
        expect(blueprint?.clientPack).toBeUndefined();
        const env = await envFor("lucky-race-manoj");
        expect(env.get("VERSION")).toBe("1.21.1");
        expect(env.get("WORLD")).toBe(curseforgeFileUrl(1574864, 8245381));
        expect(env.get("PVP")).toBe("true");
    });
});

describe("a CurseForge file address", () => {
    it("is the website's download route, which redirects to the CDN", () => {
        expect(curseforgeFileUrl(650290, 4752754)).toBe(
            "https://www.curseforge.com/api/v1/mods/650290/files/4752754/download"
        );
    });
});
