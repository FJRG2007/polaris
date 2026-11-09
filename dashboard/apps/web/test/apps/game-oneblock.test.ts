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
import * as phases from "@polaris-app/game-servers/src/lib/minecraft/oneblock-phases";
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
/** Every file written onto the server, by path. */
let written: Map<string, string> = new Map();

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

/** The folder the plugin really writes to: its plugin.yml name, `Oneblock`. A
 *  read anywhere else finds nothing, as it does on the server's disk. */
const PLUGIN_DIR = "/data/plugins/Oneblock";

vi.mock("@polaris-app/game-servers/src/lib/container-files", () => ({
    readContainerFile: async (_server: unknown, path: string) =>
        path === `${PLUGIN_DIR}/config.yml` ? file : null,
    writeContainerFile: async (_server: unknown, path: string, content: string) => {
        if (writeFails) throw new Error("container went away");
        written.set(path, content);
    }
}));

/** What the server's log says it started as. */
let version: string | null = "26.3";
/** Thrown by the next file write, when set. */
let writeFails = false;

vi.mock("@polaris-app/game-servers/src/lib/minecraft/server-version", () => ({
    serverVersion: async () => version
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
    written = new Map();
    version = "26.3";
    writeFails = false;
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

describe("the classic phases", () => {
    /** The file parsed the way the plugin reads it: level key -> its list. */
    function levels(text: string): Map<string, string[]> {
        const out = new Map<string, string[]>();
        let current: string[] | null = null;
        for (const line of text.split("\n")) {
            const head = /^'(\d+)':$/.exec(line);
            if (head?.[1]) out.set(head[1], (current = []));
            else if (line.startsWith("- ") && current) current.push(line.slice(2));
            else if (line.startsWith("  weight: ") && current)
                current[current.length - 1] += ` x${line.slice(10)}`;
        }
        return out;
    }

    it("is a blueprint of its own on the same plugin and void", () => {
        const plain = findBlueprint("oneblock");
        const classic = findBlueprint("oneblock-classic");
        expect(classic?.projects).toEqual(plain?.projects);
        expect(classic?.env).toEqual(plain?.env);
        expect(classic?.levelType).toBe(FLAT_LEVEL_TYPE);
    });

    it("walks ten phases from plains to the End, each a level with a name, colour and length", () => {
        const file = levels(phases.phasesFile());
        expect([...file.keys()]).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
        expect(file.get("0")?.slice(0, 3)).toEqual(["'Level: 0 - Plains'", "GREEN", "100"]);
        expect(file.get("9")?.[0]).toBe("'Level: 9 - The End'");
    });

    it("is never a file the plugin takes for its legacy schema and rewrites", () => {
        const text = phases.phasesFile();
        // Legacy is a scalar MaxLevel or a bare-string pool entry.
        expect(text).toMatch(/\nMaxLevel:\n$/);
        for (const entries of levels(text).values())
            for (const entry of entries.slice(3))
                expect(entry).toMatch(/^(block|mob|chest): [A-Z_a-z]+ x\d+$/);
    });

    it("names only the chests the plugin ships", () => {
        const chests = [...phases.phasesFile().matchAll(/chest: (\w+)/g)].map((m) => m[1]);
        expect(new Set(chests)).toEqual(new Set(["small_chest", "medium_chest", "high_chest"]));
    });

    it("weights each phase's own blocks to at least half of the pool it draws from", () => {
        // The plugin's pools are cumulative, so without weights the End is mostly grass.
        let pool = 0;
        for (const phase of phases.CLASSIC_PHASE_LIST) {
            const weight = phases.ownWeight(pool, phase.blocks.length);
            const own = weight * phase.blocks.length;
            expect(own * 2).toBeGreaterThanOrEqual(pool + own);
            pool += own + (phase.chest ? Math.max(1, Math.round(weight / 4)) : 0);
        }
    });

    it("is written once the plugin has loaded, then reloaded, then left to the operator", async () => {
        install = { config: JSON.stringify({ blueprintId: "oneblock-classic" }) };
        await applyOneBlockSetup("owner", "app", install.config);
        expect(written.size).toBe(0);

        file = BUNDLED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(written.get(`${PLUGIN_DIR}/${phases.ONEBLOCK_BLOCKS_FILE}`)).toBe(
            phases.phasesFile(phases.phasesFor("26.3"))
        );
        expect(sent).toEqual([["ob reload"], oneblock.setupLines("world")]);
        expect(JSON.parse(install.config).oneblockPhases).toBe("classic");

        written.clear();
        file = CONFIGURED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(written.size).toBe(0);
        expect(JSON.parse(install.config).oneblockReady).toBe(true);
    });

    it("holds only what the server's release has", () => {
        const on = (release: string) => phases.phasesFile(phases.phasesFor(release));
        // 1.16.5: no copper, moss, deepslate or cherry; the Nether's own blocks are there.
        for (const name of [
            "COPPER_ORE",
            "MOSS_BLOCK",
            "DEEPSLATE",
            "FLOWERING_AZALEA_LEAVES",
            "CHERRY_LOG",
            "BAMBOO_BLOCK"
        ])
            expect(on("1.16.5")).not.toContain(`: ${name}\n`);
        expect(on("1.16.5")).toContain("block: BLACKSTONE\n");
        expect(on("1.16.5")).toContain("mob: PIGLIN\n");
        // 1.19.4: the 1.17 blocks, still no cherry or bamboo block.
        expect(on("1.19.4")).toContain("block: COPPER_ORE\n");
        expect(on("1.19.4")).not.toContain("block: CHERRY_LOG\n");
        expect(on("1.19.4")).not.toContain("block: BAMBOO_BLOCK\n");
        expect(on("26.3")).toContain("block: CHERRY_LOG\n");
        // And no phase is left with nothing to draw.
        for (const release of ["1.13", "1.16.5", "1.19.4"])
            for (const phase of phases.phasesFor(release))
                expect(phase.blocks.length).toBeGreaterThan(0);
    });

    it("waits for the log to say which release the server runs", async () => {
        install = { config: JSON.stringify({ blueprintId: "oneblock-classic" }) };
        file = BUNDLED;
        version = null;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(written.size).toBe(0);
        expect(JSON.parse(install.config).oneblockPhases).toBeUndefined();
    });

    it("still places the first block when writing the phases fails", async () => {
        install = { config: JSON.stringify({ blueprintId: "oneblock-classic" }) };
        file = BUNDLED;
        writeFails = true;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await applyOneBlockSetup("owner", "app", install.config);
        expect(sent).toEqual([oneblock.setupLines("world")]);
        expect(JSON.parse(install.config).oneblockPhases).toBeUndefined();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("is never written on a plain OneBlock server", async () => {
        file = BUNDLED;
        await applyOneBlockSetup("owner", "app", install.config);
        expect(written.size).toBe(0);
        expect(sent).toEqual([oneblock.setupLines("world")]);
    });
});
