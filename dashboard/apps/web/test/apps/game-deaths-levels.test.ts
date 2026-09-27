/**
 * The last death and everybody's level, for the side panel and announcements.
 *
 * What is pinned: a death is recognised by the game's own templates and nothing
 * a player types can pass for one; the last one is kept on the install so a
 * restart does not lose it; levels come from one command, highest first; and a
 * side panel line of `{server.levels}` becomes a line a player, in the room the
 * other lines leave.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    config: {} as Record<string, unknown>,
    patched: [] as Record<string, unknown>[],
    log: "",
    levels: ""
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ name: "Survival", config: JSON.stringify(fake.config) })
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
                fake.patched.push(patch);
                fake.config = { ...fake.config, ...patch };
            }
        },
        chatCalls: { voicePresence: async () => new Map() }
    }
}));

const events = await import("@polaris-app/game-servers/src/lib/minecraft/player-events");
const { spreadListLines } = await import("@polaris-app/game-servers/src/lib/minecraft/rankings");
const { liveContext } = await import("@polaris-app/game-servers/src/lib/minecraft/live-values");
const { fillValues, variableProblem } =
    await import("@polaris-app/game-servers/src/lib/minecraft/text-vars");
const { sidebarProblems, DEFAULT_SIDEBAR } =
    await import("@polaris-app/game-servers/src/lib/minecraft/sidebar");

const server = {
    say: async () => fake.levels,
    run: async (argv: readonly string[]) =>
        argv[0] === "tail" ? { code: 0, output: fake.log } : { code: 1, output: "" }
};

beforeEach(() => {
    fake.config = {};
    fake.patched = [];
    fake.log = "";
    fake.levels = "";
});

describe("recognising a death", () => {
    it("knows the game's own death messages", () => {
        expect(events.deathIn("Steve fell from a high place")).toEqual({
            player: "Steve",
            message: "Steve fell from a high place"
        });
        expect(events.deathIn("Alex was slain by Zombie")?.player).toBe("Alex");
        expect(events.deathIn("Alex was shot by Skeleton using Bow")?.player).toBe("Alex");
        expect(events.deathIn("Steve_2 drowned")?.player).toBe("Steve_2");
    });

    it("does not take anything else for one", () => {
        expect(events.deathIn("Steve joined the game")).toBeNull();
        expect(events.deathIn("Steve has made the advancement [Stone Age]")).toBeNull();
        expect(events.deathIn("<Steve> Alex fell from a high place")).toBeNull();
        expect(events.deathIn("Steve lost connection: Disconnected")).toBeNull();
    });

    it("finds the newest one in the log, vanilla or Paper", () => {
        const log = [
            "[18:01:02] [Server thread/INFO]: Steve fell from a high place",
            "[18:02:10] [Server thread/INFO]: <Alex> haha Steve died",
            "[18:03:00 INFO]: Alex was blown up by Creeper",
            "[18:04:00] [Server thread/INFO]: Alex joined the game"
        ].join("\n");
        expect(events.lastDeathInLog(log)).toEqual({
            player: "Alex",
            message: "Alex was blown up by Creeper"
        });
        expect(events.lastDeathInLog("[1] [x]: nothing here")).toBeNull();
    });
});

describe("levels", () => {
    it("are read from one reply, highest first", () => {
        const reply = [
            "Alex has the following entity data: 5",
            "Steve has the following entity data: 12",
            "Zed has the following entity data: 5"
        ].join("\n");
        expect(events.readLevels(reply)).toEqual([
            { name: "Steve", level: 12 },
            { name: "Alex", level: 5 },
            { name: "Zed", level: 5 }
        ]);
        expect(events.readLevels(".Steve has the following entity data: 3")).toEqual([
            { name: ".Steve", level: 3 }
        ]);
    });

    it("spread a side panel line into a line a player, in the room left", () => {
        const lines = ["Online: {server.online}", "&e{server.levels}", "", "{death.message}"];
        expect(
            spreadListLines(lines, { "server.levels": ["Steve Lv 12", "Alex Lv 5"] }, 15)
        ).toEqual([
            "Online: {server.online}",
            "&eSteve Lv 12",
            "&eAlex Lv 5",
            "",
            "{death.message}"
        ]);
        // Three other lines on a panel of five leave two: one player and the rest counted.
        expect(
            spreadListLines(lines, { "server.levels": ["A Lv 3", "B Lv 2", "C Lv 1"] }, 5)
        ).toEqual(["Online: {server.online}", "&eA Lv 3", "&e+2 more", "", "{death.message}"]);
        // Nobody online: left for its fallback.
        expect(spreadListLines(['{server.levels | "Nobody"}'], {}, 15)).toEqual([
            '{server.levels | "Nobody"}'
        ]);
    });
});

describe("what the side panel and announcements are filled with", () => {
    it("accepts the new variables on the panel, and refuses them on Bedrock", () => {
        const lines = ["{server.levels}", "Last death: {death.player}", "{death.message}"];
        expect(sidebarProblems({ ...DEFAULT_SIDEBAR, enabled: true, lines }).lines).toEqual([
            null,
            null,
            null
        ]);
        expect(variableProblem("{death.player}", "bedrock")).toMatch(/Bedrock/);
    });

    it("reads everybody's level from the server", async () => {
        fake.levels =
            "Steve has the following entity data: 12\nAlex has the following entity data: 5";
        const context = await liveContext("install", ["{server.levels}"], null, server);
        expect(context.values["server.levels"]).toBe("Steve Lv 12, Alex Lv 5");
        expect(context.lists?.["server.levels"]).toEqual(["Steve Lv 12", "Alex Lv 5"]);
    });

    it("keeps the last death, and still has it once the log has started again", async () => {
        fake.log = "[18:01:02] [Server thread/INFO]: Steve fell from a high place\n";
        const first = await liveContext("install", ["{death.message}"], null, server);
        expect(first.values["death.message"]).toBe("Steve fell from a high place");
        expect(fake.patched).toHaveLength(1);

        // A restart: a new log with no death in it yet.
        fake.log = "[09:00:00] [Server thread/INFO]: Done (3.2s)!\n";
        const after = await liveContext(
            "install",
            ["{death.player} {death.message}"],
            null,
            server
        );
        expect(fillValues("{death.player}: {death.message}", after.values)).toBe(
            "Steve: Steve fell from a high place"
        );
        // Seen again, not written again.
        expect(fake.patched).toHaveLength(1);
    });

    it("keeps a death with a long custom name once, cut to fit", async () => {
        const killer = "K".repeat(300);
        fake.log = `[18:01:02] [Server thread/INFO]: Steve was slain by ${killer}
`;
        const first = await liveContext("install", ["{death.message}"], null, server);
        expect(first.values["death.message"]).toHaveLength(256);
        await liveContext("install", ["{death.message}"], null, server);
        expect(fake.patched).toHaveLength(1);
        expect(events.readLastDeath(fake.config)?.message).toBe(first.values["death.message"]);
    });

    it("reads as the fallback before anybody has died", async () => {
        const context = await liveContext(
            "install",
            ['{death.player | "Nobody yet"}'],
            null,
            server
        );
        expect(fillValues('{death.player | "Nobody yet"}', context.values)).toBe("Nobody yet");
    });
});
