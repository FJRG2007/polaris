/**
 * The OneBlock blueprint, and the one console step Polaris takes for it.
 *
 * The plugin does nothing until it has been told where the first block goes, so
 * what is asserted is that a server built on it floats in a void, that the walk
 * tells the plugin once and only while its own file still says it was never set,
 * and that a server whose file already holds an origin - Polaris's or one an
 * operator chose - is left exactly as it is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as oneblock from "@polaris-app/game-servers/src/lib/minecraft/oneblock";
import { FLAT_LEVEL_TYPE } from "@polaris-app/game-servers/src/lib/minecraft/world";
import { findBlueprint } from "@polaris-app/game-servers/src/lib/minecraft/blueprints";
import { forgetModrinthAnswers } from "@polaris-app/game-servers/src/lib/minecraft/modrinth";
import { blueprintFor, minecraftShapeEnv } from "@polaris-app/game-servers/src/lib/games-create";

/** The plugin's own bundled file, cut to the lines that matter here. */
const BUNDLED = "world: world\nx: 0.0\ny: 0.0\nz: 0.0\n#comment\nset: 0\ncirclemode: true\n";
const CONFIGURED = BUNDLED.replace("set: 0", "set: 100");

let install = { config: "{}" };
/** What the server's plugin file says, or null for a plugin not loaded yet. */
let file: string | null = null;
/** Every batch of console lines the server was sent. */
let sent: string[][] = [];

vi.mock("@/lib/apps/install-config", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/apps/install-config")>();
    return {
        ...real,
        patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
            install = { config: JSON.stringify({ ...JSON.parse(install.config), ...patch }) };
        }
    };
});

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (
        _ownerId: string,
        _installedAppId: string,
        work: (server: unknown) => Promise<unknown>
    ) =>
        work({
            running: true,
            sayAll: async (lines: string[]) => {
                sent.push(lines);
            }
        })
}));

vi.mock("@polaris-app/game-servers/src/lib/container-files", () => ({
    readContainerFile: async () => file
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-announcements-service", () => ({
    levelOf: async () => "world"
}));

const { applyOneBlockSetup } =
    await import("@polaris-app/game-servers/src/lib/minecraft/oneblock-service");

beforeEach(() => {
    install = { config: JSON.stringify({ blueprintId: "oneblock" }) };
    file = null;
    sent = [];
    forgetModrinthAnswers();
    vi.stubGlobal("fetch", async (url: string) => ({
        ok: true,
        json: async () =>
            url.includes("/tag/game_version")
                ? [{ version: "26.3", version_type: "release" }]
                : [{ game_versions: ["26.3"], version_type: "release" }]
    }));
});

describe("the OneBlock blueprint", () => {
    it("is a Paper server with the plugin, on a void world", async () => {
        const blueprint = findBlueprint("oneblock");
        expect(blueprint?.software).toBe("PAPER");
        expect(blueprint?.projects).toEqual(["oneblock_bukkit"]);
        const env = await minecraftShapeEnv(
            "java",
            blueprintFor("java", "oneblock"),
            { blueprintId: "oneblock", version: "LATEST", concurrentPlayers: 8, crossplay: false },
            new Map()
        );
        expect(env.get("LEVEL_TYPE")).toBe(FLAT_LEVEL_TYPE);
        const settings = JSON.parse(env.get("GENERATOR_SETTINGS") ?? "{}");
        expect(settings.layers).toEqual([{ block: "minecraft:air", height: 1 }]);
        expect(env.get("MODRINTH_PROJECTS")).toContain("oneblock_bukkit");
    });

    it("is not offered for Bedrock", () => {
        expect(findBlueprint("oneblock")?.editions).toEqual(["java"]);
    });
});

describe("reading the plugin's file", () => {
    it("takes an offset of zero as never set", () => {
        expect(oneblock.islandOffset(BUNDLED)).toBe(0);
        expect(oneblock.isSetUp(BUNDLED, "world")).toBe(false);
        expect(oneblock.isSetUp(CONFIGURED, "world")).toBe(true);
    });

    it("takes a file that does not say as not set", () => {
        expect(oneblock.islandOffset("world: world\n")).toBeNull();
        expect(oneblock.isSetUp("world: world\n", "world")).toBe(false);
    });

    it("takes islands left in the level Polaris set it up on as not set", () => {
        // A new world is a new level folder; the file still names the old one.
        expect(oneblock.islandWorld(CONFIGURED)).toBe("world");
        expect(oneblock.islandWorld('world: "world-20261107"\n')).toBe("world-20261107");
        expect(oneblock.isSetUp(CONFIGURED, "world-20261107", "world")).toBe(false);
    });

    it("takes islands an operator put in another world as set", () => {
        expect(oneblock.isSetUp(CONFIGURED, "world-20261107")).toBe(true);
        expect(oneblock.isSetUp(CONFIGURED, "world-20261107", "world-old")).toBe(true);
    });

    it("sends the console form of the command, on the server's own world", () => {
        expect(oneblock.setupLines("lobby")).toEqual([
            "ob set 100 0 64 0 lobby",
            "ob autojoin true"
        ]);
    });
});

describe("setting it up from the walk", () => {
    it("waits while the plugin has not written its file", async () => {
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toEqual([]);
        expect(JSON.parse(install.config).oneblockReady).toBeUndefined();
    });

    it("tells a plugin that was never set, and marks it only once its file agrees", async () => {
        file = BUNDLED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toEqual([oneblock.setupLines("world")]);
        expect(JSON.parse(install.config).oneblockReady).toBeUndefined();

        file = CONFIGURED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toHaveLength(1);
        expect(JSON.parse(install.config).oneblockReady).toBe(true);
        expect(JSON.parse(install.config).oneblockWorld).toBe("world");

        // Marked: the next walk does not open the server at all.
        file = BUNDLED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toHaveLength(1);
    });

    it("leaves an origin somebody already chose alone", async () => {
        file = CONFIGURED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toEqual([]);
    });

    it("sets the plugin up again on a new world", async () => {
        install = {
            config: JSON.stringify({ blueprintId: "oneblock", oneblockWorld: "world-old" })
        };
        file = CONFIGURED.replace("world: world", "world: world-old");
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toEqual([oneblock.setupLines("world")]);
        expect(JSON.parse(install.config).oneblockReady).toBeUndefined();
    });

    it("leaves islands an operator put in another world alone", async () => {
        file = CONFIGURED.replace("world: world", "world: skylands");
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toEqual([]);
        expect(JSON.parse(install.config).oneblockReady).toBe(true);
    });

    it("stops telling a plugin that never takes it", async () => {
        file = BUNDLED;
        for (let pass = 0; pass < oneblock.MAX_TRIES; pass += 1)
            await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toHaveLength(oneblock.MAX_TRIES);
        expect(JSON.parse(install.config).oneblockReady).toBe(true);
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toHaveLength(oneblock.MAX_TRIES);
    });

    it("does nothing on a server built on another blueprint", async () => {
        file = BUNDLED;
        await applyOneBlockSetup("owner", "app", JSON.stringify({ blueprintId: "skyblock" }));
        expect(sent).toEqual([]);
    });
});
