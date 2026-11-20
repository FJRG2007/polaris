/**
 * Lucky Block Race: the blueprint, the pack Polaris writes for it, and the one
 * visit that puts it on a server.
 *
 * A function file that fails to parse is dropped whole by the game, silently,
 * so what is asserted about the pack is mostly that it stays inside syntax every
 * release from 1.21 reads, and that every function it calls is one it ships.
 * The pack itself was run on a real 26.3 server: it loads clean, builds the
 * course with its 128 lucky blocks, and a round goes from countdown to result to
 * rebuilt course.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as race from "@polaris-app/game-servers/src/lib/minecraft/lucky-race";
import { FLAT_LEVEL_TYPE } from "@polaris-app/game-servers/src/lib/minecraft/world";
import { findBlueprint } from "@polaris-app/game-servers/src/lib/minecraft/blueprints";
import { VOID_GENERATOR_SETTINGS } from "@polaris-app/game-servers/src/lib/minecraft/oneblock";

let install = { config: "{}" };
let datapacks: string[] = [];
let sent: string[][] = [];
let said: string[] = [];
let written: Map<string, string> = new Map();
let enabled = false;

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
            edition: "java",
            run: async () => ({ code: 0, stdout: "", stderr: "" }),
            say: async ([line]: string[]) => {
                said.push(line ?? "");
                if (line?.startsWith("datapack enable")) enabled = true;
                return line === "datapack list enabled" && enabled
                    ? `There are 2 data packs enabled: [vanilla (built-in)], [file/${race.RACE_PACK_DIR} (world)]`
                    : "";
            },
            sayAll: async (lines: string[]) => {
                sent.push(lines);
            }
        })
}));

vi.mock("@polaris-app/game-servers/src/lib/container-files", () => ({
    listContainerDir: async () => datapacks,
    readContainerFiles: async () => new Map(),
    writeContainerFile: async (_server: unknown, path: string, content: string) => {
        written.set(path, content);
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-announcements-service", () => ({
    levelOf: async () => "world"
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/speech-service", () => ({
    homeLanguage: async (_owner: string, chosen: string | null) => chosen ?? "es"
}));

const { applyLuckyRaceSetup } =
    await import("@polaris-app/game-servers/src/lib/minecraft/lucky-race-service");

beforeEach(() => {
    install = { config: JSON.stringify({ blueprintId: race.LUCKY_RACE_BLUEPRINT }) };
    datapacks = [];
    sent = [];
    said = [];
    written = new Map();
    enabled = false;
});

describe("the Lucky Block Race blueprint", () => {
    it("is a Paper server with the Lucky Blocks pack on a void world", () => {
        const blueprint = findBlueprint(race.LUCKY_RACE_BLUEPRINT);
        expect(blueprint?.software).toBe("PAPER");
        expect(blueprint?.projects).toEqual(["datapack:ly-lucky-blocks"]);
        expect(blueprint?.levelType).toBe(FLAT_LEVEL_TYPE);
        expect(blueprint?.env?.GENERATOR_SETTINGS).toBe(VOID_GENERATOR_SETTINGS);
        expect(blueprint?.env?.PVP).toBe("true");
    });
});

describe("the race pack", () => {
    const files = race.racePackFiles("en");
    const functions = race.raceFunctions("en");
    const lines = Object.values(functions).flat();

    it("calls only functions it ships, or the Lucky Blocks pack's place", () => {
        const called = new Set(
            lines.flatMap((line) => [...line.matchAll(/function ([a-z_]+:[a-z_/0-9]+)/g)].map((m) => m[1]))
        );
        for (const name of called) {
            if (name === "lucky_blocks:block/place") continue;
            expect(name?.startsWith("polaris_race:")).toBe(true);
            expect(files.has(`data/polaris_race/function/${name?.slice(13)}.mcfunction`)).toBe(true);
        }
    });

    it("runs on tick and load", () => {
        expect(JSON.parse(files.get("data/minecraft/tags/function/tick.json") ?? "{}").values).toEqual([
            "polaris_race:tick"
        ]);
        expect(JSON.parse(files.get("data/minecraft/tags/function/load.json") ?? "{}").values).toEqual([
            "polaris_race:load"
        ]);
    });

    it("never puts a game rule or a range coordinate in a function file", () => {
        // A function that fails to parse is dropped whole; both have.
        for (const line of lines) {
            expect(line).not.toMatch(/^gamerule /);
            expect(line).not.toMatch(/[[,][xyz]=-?\d*\.\./);
        }
    });

    it("cuts every fill to what the game accepts", () => {
        for (const line of lines.filter((l) => l.startsWith("fill "))) {
            const [x1, y1, z1, x2, y2, z2] = line.split(" ").slice(1, 7).map(Number) as number[];
            const volume = (Math.abs(x2! - x1!) + 1) * (Math.abs(y2! - y1!) + 1) * (Math.abs(z2! - z1!) + 1);
            expect(volume).toBeLessThanOrEqual(race.FILL_LIMIT);
        }
    });

    it("stacks two lucky blocks at every checkpoint of every lane", () => {
        const places = lines.filter((line) => line.endsWith("lucky_blocks:block/place"));
        expect(places).toHaveLength(race.COURSE.lanes.length * race.COURSE.checkpoints * 2);
    });

    it("speaks the server's language", () => {
        expect(race.raceFunctions("es").lobby_second?.[0]).toContain("esmeralda");
        expect(functions.lobby_second?.[0]).toContain("emerald");
    });

    it("sets each world rule in both spellings, then builds", () => {
        const console = race.consoleLines();
        expect(console).toContain("gamerule doImmediateRespawn true");
        expect(console).toContain("gamerule immediate_respawn true");
        expect(console.at(-1)).toBe("function polaris_race:setup");
    });
});

describe("setting a server up", () => {
    it("waits for the Lucky Blocks pack before writing anything", async () => {
        await applyLuckyRaceSetup("owner", "app", install.config);
        expect(written.size).toBe(0);
        expect(sent).toEqual([]);
        expect(JSON.parse(install.config)[race.RACE_SETUP_KEY]).toBeUndefined();
    });

    it("writes the pack, switches it on with /datapack, builds, and records it", async () => {
        datapacks = ["Lucky Blocks v1.3.3 [26.3].zip"];
        await applyLuckyRaceSetup("owner", "app", install.config);
        expect(written.get(`/data/world/datapacks/${race.RACE_PACK_DIR}/pack.mcmeta`)).toBeDefined();
        expect(said).not.toContain("reload");
        expect(said).toContain(`datapack enable "file/${race.RACE_PACK_DIR}"`);
        expect(sent).toEqual([race.consoleLines()]);
        expect(JSON.parse(install.config)[race.RACE_SETUP_KEY]).toBe(race.RACE_VERSION);

        sent = [];
        await applyLuckyRaceSetup("owner", "app", install.config);
        expect(sent).toEqual([]);
    });

    it("leaves every other server alone", async () => {
        install = { config: JSON.stringify({ blueprintId: "luckyblock" }) };
        datapacks = ["Lucky Blocks v1.3.3 [26.3].zip"];
        await applyLuckyRaceSetup("owner", "app", install.config);
        expect(written.size).toBe(0);
    });
});
