/**
 * What a blueprint actually builds.
 *
 * The failure this file exists for is a silent one: a blueprint whose plugin had
 * no build for the release being installed produced an ordinary survival server,
 * said so only in a log, and looked exactly like every other server the operator
 * had made. So what is asserted is that the release is pinned to one the plugins
 * can run on, that a release they cannot run on is refused rather than installed
 * around, that the plugin entries are the kind the image refuses to start without,
 * and that resetting a server onto another blueprint takes the previous one's
 * plugin back off it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { entryReleaseType, projectSlug } from "@/lib/apps/minecraft/modrinth";
import { commonVersions, knownUnsupported } from "@/lib/apps/minecraft/blueprint-version";
import { blueprintFor, minecraftShapeEnv, withoutBlueprintProjects } from "@/lib/apps/games-create";
import { CROSSPLAY_PROJECTS, GAME_BLUEPRINTS, findBlueprint } from "@/lib/apps/minecraft/blueprints";

/** Minecraft's releases as the tag endpoint gives them: newest first, and with
 *  the snapshots a blueprint must never pin mixed in. */
const RELEASES = ["1.21.6", "1.21.5", "1.21.4", "1.21.3", "1.20.6"];

/** What each project has a finished release for, by slug. Anything not named here
 *  answers as a project Modrinth has never heard of. */
let supported: Map<string, string[]>;
/** And what it only ever published as a snapshot - which is how BedWars1058 ships
 *  every release from 1.21 on, and the reason a server built on one restarted
 *  forever until the entry said it would take a beta. */
let betaOnly: Map<string, string[]>;
/** Set to fail every request, which is the "index could not be reached" case. */
let offline = false;
/** Every URL Modrinth was asked for, so a test can assert what was asked as well
 *  as what came back. */
let asked: string[] = [];

beforeEach(() => {
    offline = false;
    asked = [];
    // Each scenario below uses a blueprint of its own, because what a project
    // supports is looked up once and remembered for the rest of the day - which is
    // the behaviour in production and would otherwise make these order-dependent.
    supported = new Map([
        ["bedwars1058", ["1.21.4", "1.21.3"]],
        ["dynamicworldborder", ["1.21.6", "1.21.5"]],
        ["iridiumskyblock", ["1.21.5", "1.21.3"]],
        ["geyser", ["1.21.6", "1.21.4"]]
    ]);
    betaOnly = new Map();
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        if (offline) throw new Error("unreachable");
        if (url.includes("/tag/game_version")) {
            return {
                ok: true,
                json: async () => [
                    ...RELEASES.map((version) => ({ version, version_type: "release" })),
                    { version: "25w01a", version_type: "snapshot" }
                ]
            } as unknown as Response;
        }
        // What a project has a build for is asked of its builds, filtered by the
        // software they load into, rather than of the project - so the answer is a
        // list of versions, each with the releases that one build covers.
        const slug = (url.split("/project/")[1] ?? "").split("/")[0] ?? "";
        return {
            ok: true,
            json: async () => [
                ...(supported.get(slug) ?? []).map((version) => ({
                    game_versions: [version],
                    version_type: "release"
                })),
                ...(betaOnly.get(slug) ?? []).map((version) => ({
                    game_versions: [version],
                    version_type: "beta"
                }))
            ]
        } as unknown as Response;
    });
});

/** The environment a server of this shape would be built with, from nothing. */
async function envFor(
    blueprintId: string,
    shape: Partial<Parameters<typeof minecraftShapeEnv>[2]> = {},
    current: Record<string, string> = {}
): Promise<Map<string, string>> {
    return minecraftShapeEnv(
        "java",
        blueprintFor("java", blueprintId),
        { blueprintId, version: "LATEST", concurrentPlayers: 8, crossplay: false, ...shape },
        new Map(Object.entries(current))
    );
}

describe("what a blueprint installs", () => {
    it("names every plugin as one the server may not start without", () => {
        // A trailing "?" is the image's "warn and carry on", which is right for the
        // protection every server gets and wrong for the plugin a blueprint exists
        // to install - that case is the silent survival server.
        for (const blueprint of GAME_BLUEPRINTS) {
            for (const project of blueprint.projects) {
                expect(project.endsWith("?"), `${blueprint.id}: ${project}`).toBe(false);
            }
        }
        for (const project of CROSSPLAY_PROJECTS) expect(project.endsWith("?")).toBe(false);
    });

    it("does not name a plugin Modrinth has no Paper build of", () => {
        // Floodgate's Modrinth project carries Fabric and NeoForge only. Naming it
        // beside Geyser asked the image for something that does not exist, which
        // was harmless while these were optional and is a server that will not
        // start now they are not.
        expect(CROSSPLAY_PROJECTS.map(projectSlug)).not.toContain("floodgate");
    });

    it("says what is still left to do for a game that ships no map of its own", () => {
        // Bed wars with no arena is a lobby, and a server that looks like an empty
        // world with nothing saying why reads as a broken install.
        const bedwars = findBlueprint("bedwars");
        expect(bedwars?.setup).toBeTruthy();
        expect(bedwars?.docs).toMatch(/^https:\/\//);
    });
});

describe("the release a blueprint is built on", () => {
    it("pins the newest one every plugin has a build for", async () => {
        const env = await envFor("bedwars");
        expect(env.get("VERSION")).toBe("1.21.4");
    });

    it("counts the crossplay plugins too, since they also have to install", async () => {
        // IridiumSkyblock runs on 1.21.5 and 1.21.3; Geyser on neither.
        expect((await envFor("skyblock")).get("VERSION")).toBe("1.21.5");
        // Nothing all three agree on, so the operator's own choice is left alone
        // rather than a version being invented for them.
        expect((await envFor("skyblock", { crossplay: true })).get("VERSION")).toBe("LATEST");
    });

    it("refuses a release the blueprint's plugins cannot run on", async () => {
        await expect(envFor("bedwars", { version: "1.21.6" })).rejects.toThrow(/nothing built for Minecraft 1\.21\.6/);
    });

    it("takes one they can", async () => {
        expect((await envFor("bedwars", { version: "1.21.3" })).get("VERSION")).toBe("1.21.3");
    });

    it("leaves a choice alone when Modrinth could not be reached", async () => {
        offline = true;
        // Nothing is known, which is not the same as "this will not work" - and
        // refusing a create over an index being down is the worse failure.
        expect((await envFor("parkour", { version: "1.21.6" })).get("VERSION")).toBe("1.21.6");
        expect((await envFor("parkour")).get("VERSION")).toBe("LATEST");
    });

    it("does not constrain a blueprint that installs nothing", async () => {
        expect((await envFor("survival")).get("VERSION")).toBe("LATEST");
    });

    it("only counts builds the image would actually install", async () => {
        // The failure this pair exists for: BedWars1058 reaches 1.21 only in
        // snapshot builds, the image takes finished releases by default, and
        // counting the snapshots anyway pinned a release it then refused to
        // install anything for. The container restarted forever on it.
        betaOnly.set("infiniteparkour", ["1.21.6"]);
        supported.set("infiniteparkour", ["1.21.3"]);
        expect(await commonVersions(["infiniteparkour"])).toEqual(["1.21.3"]);
        expect(await commonVersions(["infiniteparkour:beta"])).toEqual(["1.21.6", "1.21.3"]);
    });

    it("reads the release type off the entry the way the image does", () => {
        expect(entryReleaseType("bedwars1058")).toBe("release");
        expect(entryReleaseType("bedwars1058:beta")).toBe("beta");
        expect(entryReleaseType("grimac?:alpha")).toBe("alpha");
        // A colon can introduce a version rather than a type, and a version is not
        // a licence to install an unfinished build.
        expect(entryReleaseType("bedwars1058:25.3-SNAPSHOT")).toBe("release");
    });

    it("only counts builds for the software the plugin will be loaded into", async () => {
        // A project reports one game_versions covering everything it has ever
        // published, across every loader at once. Trusting that pins a Paper
        // server to a release only the Fabric build reaches, and the plugin - now
        // a required entry - has nothing to install there.
        asked = [];
        await envFor("shrinking-world");
        expect(asked.some((url) => url.includes("/version?loaders=") && url.includes("paper"))).toBe(true);
        expect(asked.some((url) => /\/project\/[^/]+$/.test(url))).toBe(false);
    });
});

describe("the world a blueprint opens on", () => {
    it("gives a minigame a lobby rather than ordinary terrain", async () => {
        expect((await envFor("bedwars")).get("LEVEL_TYPE")).toBe("minecraft:flat");
        expect((await envFor("survival")).get("LEVEL_TYPE")).toBe("minecraft:normal");
    });

    it("lets the operator override it", async () => {
        expect((await envFor("bedwars", { levelType: "minecraft:amplified" })).get("LEVEL_TYPE")).toBe(
            "minecraft:amplified"
        );
    });

    it("writes the seed every time, and never leaves the last one behind", async () => {
        // A seed left over from the last world would quietly generate the
        // previous one under the new one's name.
        const rolled = (await envFor("survival", {}, { SEED: "12345" })).get("SEED");
        expect(rolled).not.toBe("12345");
        // And never blank. An empty value is not "surprise me" to an image: it
        // is somewhere between unset, empty and zero - and zero is a real seed
        // that hands everybody the same world. One is minted instead.
        expect(rolled).toMatch(/^-?[0-9]+$/);
        expect((await envFor("survival", { seed: "spawn island" })).get("SEED")).toBe("spawn island");
    });

    it("gives two servers two different worlds", async () => {
        // The one people actually noticed: every server they made came out the
        // same map.
        const first = (await envFor("survival")).get("SEED");
        const second = (await envFor("survival")).get("SEED");
        expect(first).not.toBe(second);
    });

    it("loads the blueprint's plugins into the software they need", async () => {
        const env = await envFor("bedwars", {}, { MODRINTH_PROJECTS: "grimac?,coreprotect?" });
        expect(env.get("TYPE")).toBe("PAPER");
        // The entry keeps the release type it was declared with, so the image
        // applies the same rule the version was resolved under.
        expect(env.get("MODRINTH_PROJECTS")).toBe("grimac?,coreprotect?,bedwars1058:beta");
        // A heavier game for the same number of players gets a heavier heap.
        expect(env.get("MEMORY")).toBe("3G");
    });
});

describe("resetting a server onto another blueprint", () => {
    it("takes the previous blueprint's plugin back off the list", () => {
        expect(withoutBlueprintProjects("grimac?,coreprotect?,bedwars1058,geyser,floodgate")).toBe(
            "grimac?,coreprotect?"
        );
    });

    it("leaves alone what somebody installed themselves", () => {
        // A change of game is not a request to uninstall the map plugin they added
        // from the Mods screen.
        expect(withoutBlueprintProjects("grimac?,dynmap,iridiumskyblock")).toBe("grimac?,dynmap");
    });

    it("survives a list that names a file rather than a project", () => {
        expect(withoutBlueprintProjects("@/data/projects.txt,bedwars1058")).toBe("@/data/projects.txt");
    });
});

describe("knowing a release will not work", () => {
    it("never says so from an answer it does not have", () => {
        // An empty list is "nothing is known", and reporting it as "this will not
        // work" is what would refuse a create because an index was down.
        expect(knownUnsupported([], "1.21.6")).toBe(false);
        expect(knownUnsupported(["1.21.4"], "1.21.6")).toBe(true);
        expect(knownUnsupported(["1.21.4"], "1.21.4")).toBe(false);
    });
});
