/**
 * Ranks saved, applied, imported, and applied again on start and on join.
 *
 * Pinned: the ranks are stored before the server is asked, so a server that is
 * off keeps them and gets them on start; an apply records what it sent and the
 * next one undoes only that; an adopted team is removed only after its players
 * moved; import reads the scoreboard after a save-all and changes nothing; a
 * ranked player who arrives joins their team; Bedrock and other games are
 * refused or skipped; and the actions need the console grant, are rate limited
 * and audited, and validate with the shared schema.
 */

import { gzipSync } from "node:zlib";
import { english } from "../setup/game-english";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rank } from "@polaris-app/game-servers/src/lib/minecraft/ranks";

const INSTALL = "aaaaaaaa-2222-4222-8222-222222222222";

let config: Record<string, unknown> = {};
let catalogId = "minecraft";
let running = true;
let reachable = true;
let consoleHolder = true;
let rateOk = true;
let scoreboard: Buffer | null = null;
const said: string[] = [];
const audits: { action: string; metadata: Record<string, string> }[] = [];
const rateKeys: string[] = [];
const readPaths: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ ownerId: "owner", catalogId, config, status: "running" })
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
            patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
                config = { ...config, ...patch };
            }
        },
        envVarService: { listEnvVars: async () => [{ key: "LEVEL", value: "survival" }] },
        auditService: {
            recordAudit: async (entry: { action: string; metadata: Record<string, string> }) => {
                audits.push(entry);
            }
        },
        rateLimitService: {
            rateLimit: async (key: string) => {
                rateKeys.push(key);
                return { ok: rateOk };
            }
        },
        appsInstallAccess: {
            requireGameServer: async (permission: string, id: string) => {
                if (permission !== "games.console" || !consoleHolder)
                    throw new Error("Server not found");
                return {
                    user: { id: "u-steve" },
                    access: { ownerId: "owner", install: { id, catalogId, applicationId: "app" } }
                };
            }
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/screens/game-words", () => ({
    gameWords: async () => (key: string) => key,
    issueText: async (message: string | undefined) => (message ? english(message) : undefined),
    messageText: async (message: string) => english(message)
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (id: string) => (id === "minecraft-bedrock" ? "bedrock" : "java"),
    withServerContainer: async (
        _owner: string,
        _id: string,
        work: (server: unknown) => unknown
    ) => {
        if (!reachable) throw new Error("not accepting commands");
        return work({
            running,
            say: async ([line]: string[]) => {
                said.push(line!);
                return "";
            },
            sayAll: async (lines: string[]) => {
                said.push(...lines);
            },
            sayEach: async (commands: string[][]) =>
                commands.map(([line]) => {
                    said.push(line!);
                    return line!.startsWith("team modify pr01_admin color")
                        ? "Unknown or incomplete command"
                        : "ok";
                }),
            readFile: async (path: string) => {
                readPaths.push(path);
                if (!scoreboard) throw new Error("No such file");
                const bytes = scoreboard;
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(bytes));
                        controller.close();
                    }
                });
            }
        });
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/games-activity-service", () => ({
    searchKnownPlayers: async () =>
        catalogId === "minecraft" ? [{ name: "Alex", online: true, playerId: null }] : []
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/world", () => ({
    levelEnvKey: () => "LEVEL",
    isLevelName: (value: string) => /^[A-Za-z0-9_-]+$/.test(value),
    defaultLevel: () => "world",
    levelParent: () => "/data"
}));

const service = await import("@polaris-app/game-servers/src/lib/minecraft/ranks-service");
const actions = await import("@polaris-app/game-servers/src/screens/installed/ranks-actions");

const ADMIN: Rank = {
    id: "admin",
    name: "Admin",
    tag: "ADMIN",
    symbol: "⚔",
    color: "red",
    bold: true,
    players: ["Steve"]
};
const VIP: Rank = {
    id: "vip",
    name: "VIP",
    tag: "VIP",
    symbol: "",
    color: "gold",
    bold: false,
    players: ["Alex"]
};

/** A scoreboard.dat with one team, `vips`, holding Alex. */
function vipScoreboard(): Buffer {
    const str = (value: string) => {
        const bytes = Buffer.from(value, "utf8");
        const head = Buffer.alloc(2);
        head.writeUInt16BE(bytes.length);
        return Buffer.concat([head, bytes]);
    };
    const field = (key: string, value: string) =>
        Buffer.concat([Buffer.from([8]), str(key), str(value)]);
    const players = Buffer.concat([
        Buffer.from([9]),
        str("Players"),
        Buffer.from([8, 0, 0, 0, 1]),
        str("Alex")
    ]);
    const team = Buffer.concat([
        field("Name", "vips"),
        field("DisplayName", '{"text":"VIP"}'),
        field("MemberNamePrefix", '{"text":"[VIP] ","color":"gold"}'),
        players,
        Buffer.from([0])
    ]);
    const teams = Buffer.concat([
        Buffer.from([9]),
        str("Teams"),
        Buffer.from([10, 0, 0, 0, 1]),
        team
    ]);
    const data = Buffer.concat([Buffer.from([10]), str("data"), teams, Buffer.from([0])]);
    return gzipSync(Buffer.concat([Buffer.from([10]), str(""), data, Buffer.from([0])]));
}

beforeEach(() => {
    config = {};
    catalogId = "minecraft";
    running = true;
    reachable = true;
    consoleHolder = true;
    rateOk = true;
    scoreboard = null;
    said.length = 0;
    audits.length = 0;
    rateKeys.length = 0;
    readPaths.length = 0;
});

describe("saving and applying", () => {
    it("stores, applies and records what it sent", async () => {
        const result = await service.saveRanks("owner", INSTALL, [ADMIN, VIP]);
        expect(result).toEqual({ applied: true, sent: 10, refused: 1 });
        expect(said[0]).toBe("team add pr01_admin");
        expect(said).toContain("team join pr02_vip Alex");
        expect(config.ranks).toEqual({
            ranks: [ADMIN, VIP],
            applied: { teams: ["pr01_admin", "pr02_vip"], players: ["Steve", "Alex"] }
        });
    });

    it("keeps the ranks for the next start when the server is off or not answering", async () => {
        running = false;
        expect(await service.saveRanks("owner", INSTALL, [ADMIN])).toEqual({
            applied: false,
            sent: 0,
            refused: 0
        });
        expect(said).toEqual([]);
        expect((config.ranks as { ranks: Rank[] }).ranks).toEqual([ADMIN]);
        expect((config.ranks as { applied: unknown }).applied).toEqual({ teams: [], players: [] });
        running = true;
        reachable = false;
        expect((await service.saveRanks("owner", INSTALL, [ADMIN])).applied).toBe(false);
    });

    it("undoes only what the last apply did, and replaces an adopted team after moving its players", async () => {
        await service.saveRanks("owner", INSTALL, [ADMIN, VIP]);
        said.length = 0;
        await service.saveRanks("owner", INSTALL, [{ ...VIP, source: "vips" }]);
        expect(said.slice(-5)).toEqual([
            "team join pr01_vip Alex",
            "team leave Steve",
            "team remove pr01_admin",
            "team remove pr02_vip",
            "team remove vips"
        ]);
        // Once applied, the adopted team is gone and the rank no longer names it.
        expect((config.ranks as { ranks: Rank[] }).ranks).toEqual([VIP]);
    });

    it("refuses Bedrock, which has no teams", async () => {
        catalogId = "minecraft-bedrock";
        await expect(service.saveRanks("owner", INSTALL, [ADMIN])).rejects.toThrow();
        expect(config.ranks).toBeUndefined();
    });
});

describe("applying again on start and on join", () => {
    it("applies the saved ranks when the server comes up, and nothing when there are none", async () => {
        expect(await service.applyRanksOnStart(INSTALL)).toBeNull();
        config = { ranks: { ranks: [ADMIN], applied: { teams: [], players: [] } } };
        const result = await service.applyRanksOnStart(INSTALL);
        expect(result?.applied).toBe(true);
        expect(said).toContain("team join pr01_admin Steve");
    });

    it("joins ranked arrivals to their team and nobody else", async () => {
        config = { ranks: { ranks: [ADMIN, VIP], applied: { teams: [], players: [] } } };
        expect(await service.applyRanksOnJoin(INSTALL, ["steve", "Herobrine"])).toBe(1);
        expect(said).toEqual(["team join pr01_admin steve"]);
    });

    it("never throws for a join or a start, and skips other games and Bedrock", async () => {
        config = { ranks: { ranks: [ADMIN], applied: { teams: [], players: [] } } };
        reachable = false;
        expect(await service.applyRanksOnJoin(INSTALL, ["Steve"])).toBe(0);
        reachable = true;
        catalogId = "minecraft-bedrock";
        expect(await service.applyRanksOnJoin(INSTALL, ["Steve"])).toBe(0);
        catalogId = "ark";
        expect(await service.applyRanksOnStart(INSTALL)).toBeNull();
        expect(said).toEqual([]);
    });
});

describe("importing", () => {
    it("saves the world, reads the scoreboard and changes nothing", async () => {
        scoreboard = vipScoreboard();
        const ranks = await service.importServerTeams("owner", INSTALL, "app");
        expect(said).toEqual(["save-all"]);
        expect(readPaths).toEqual(["/data/survival/data/scoreboard.dat"]);
        expect(ranks).toEqual([
            {
                id: "vip",
                name: "VIP",
                tag: "VIP",
                symbol: "",
                color: "gold",
                bold: false,
                players: ["Alex"],
                source: "vips"
            }
        ]);
        expect(config.ranks).toBeUndefined();
    });

    it("finds no teams in a world that has none", async () => {
        expect(await service.importServerTeams("owner", INSTALL, "app")).toEqual([]);
    });
});

describe("the actions", () => {
    it("need the console grant", async () => {
        consoleHolder = false;
        expect((await actions.readRanksAction(INSTALL)).view).toBeUndefined();
        expect(
            (await actions.saveRanksAction({ installedAppId: INSTALL, ranks: [ADMIN] })).saved
        ).toBeUndefined();
        expect((await actions.importRanksAction(INSTALL)).ranks).toBeUndefined();
        expect(said).toEqual([]);
        expect(audits).toEqual([]);
    });

    it("validate with the shared schema before anything is stored", async () => {
        const result = await actions.saveRanksAction({
            installedAppId: INSTALL,
            ranks: [{ ...ADMIN, players: ["@a"] }]
        });
        expect(result.error).toBe("Not a valid player name");
        expect(config.ranks).toBeUndefined();
    });

    it("save, audit and say whether the server took it", async () => {
        const result = await actions.saveRanksAction({ installedAppId: INSTALL, ranks: [ADMIN] });
        expect(result.saved).toEqual({ ranks: [ADMIN], applied: true, refused: 1 });
        expect(audits[0]).toMatchObject({
            action: "minecraft.ranks.save",
            metadata: { ranks: "1", applied: "true" }
        });
        expect(rateKeys).toEqual(["games-ranks:u-steve"]);
    });

    it("are rate limited", async () => {
        rateOk = false;
        expect(
            (await actions.saveRanksAction({ installedAppId: INSTALL, ranks: [ADMIN] })).error
        ).toBe("ranks.rateLimited");
        expect((await actions.importRanksAction(INSTALL)).error).toBe("ranks.rateLimited");
        expect(config.ranks).toBeUndefined();
    });

    it("read the ranks with the server's players for the picker", async () => {
        expect((await actions.readRanksAction(INSTALL)).view).toEqual({
            ranks: [],
            edition: "java",
            players: [{ name: "Alex", online: true }]
        });
    });

    it("read the edition, so the screen can say why Bedrock has none", async () => {
        catalogId = "minecraft-bedrock";
        expect((await actions.readRanksAction(INSTALL)).view).toEqual({
            ranks: [],
            edition: "bedrock",
            players: []
        });
    });
});
