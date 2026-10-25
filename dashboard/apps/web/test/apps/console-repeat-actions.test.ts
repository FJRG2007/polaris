/**
 * Starting, watching and stopping a repeat, as the server takes it.
 *
 * Pinned: a repeat needs the console grant a single run needs, and is refused
 * whole without it; the repeat is checked by the shared schema before
 * anything runs; "every player online" is worked out again on every run, so a
 * player who joins halfway is in the next one; a grant taken away or a server
 * restarted ends it; anybody with the console sees and stops it; and starting
 * them faster than anybody would by hand is refused.
 */

import { english } from "../setup/game-english";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedCommand } from "@polaris-app/game-servers/src/lib/console-commands";

const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const KEPT = "bbbbbbbb-1111-4111-8111-111111111111";

const sent: { actor: string; line: string }[] = [];
const audits: string[] = [];
let kept: SavedCommand[] = [];
let online: string[] = [];
/** Who has the console on the server. */
let consoleUsers = new Set<string>();
let desiredState = "running";
let boot = "2026-10-25T10:00:00Z";
let allowed = true;

vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findFirst: async () => ({ desiredState }) }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        auditService: {
            recordAudit: async (entry: { action: string }) => {
                audits.push(entry.action);
            }
        },
        rateLimitService: { rateLimit: async () => ({ ok: allowed }) },
        appContainerMetrics: {
            readAppContainerRuntime: async () => ({
                status: "running",
                restartCount: 0,
                startedAt: boot
            })
        },
        appsInstallConfig: { readInstallConfig: () => ({}), patchInstallConfig: async () => {} },
        mcp: { actingUser: async (id: string) => ({ id }) },
        appsInstallAccess: {
            gameServerAccess: async (user: { id: string }, id: string, permission: string) =>
                id === INSTALL && permission === "games.console" && consoleUsers.has(user.id)
                    ? { install: { id } }
                    : null,
            requireGameServer: async (permission: string, id: string) => {
                if (permission !== "games.console" || !consoleUsers.has("u-ada")) {
                    throw new Error("Server not found");
                }
                return {
                    user: { id: "u-ada", name: "Ada" },
                    access: {
                        ownerId: "owner",
                        install: { id, catalogId: "minecraft", applicationId: "app" }
                    }
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

vi.mock("@polaris-app/game-servers/src/lib/console-command-service", () => ({
    readConsoleCommands: async () => kept,
    saveConsoleCommand: async () => kept,
    addConsoleSchedule: async () => [],
    deleteConsoleCommand: async () => [],
    readConsoleSchedulesOf: async () => [],
    removeConsoleSchedule: async () => []
}));

vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    runConsoleCommand: async (actor: { id: string }, _server: unknown, line: string) => {
        sent.push({ actor: actor.id, line });
        return "ok";
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    shownPlayers: async () => ({ players: [...online] })
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-values", () => ({
    liveContext: async () => ({ values: {}, recipients: null })
}));

const actions = await import("@polaris-app/game-servers/src/screens/installed/console-actions");
const jobs = await import("@polaris-app/game-servers/src/lib/console-repeat-jobs");

const PIGLIN = "/execute at {player} run summon minecraft:piglin_brute ~4 ~ ~";
const EVERY_5S = { times: 3, every: 5, unit: "seconds" } as const;

beforeEach(() => {
    vi.useFakeTimers();
    jobs.resetRepeatsForTest();
    sent.length = 0;
    audits.length = 0;
    kept = [{ id: KEPT, label: "Spawn piglin", command: PIGLIN, variables: [] }];
    online = ["Alex"];
    consoleUsers = new Set(["u-ada"]);
    desiredState = "running";
    boot = "2026-10-25T10:00:00Z";
    allowed = true;
});
afterEach(() => {
    jobs.resetRepeatsForTest();
    vi.useRealTimers();
});

const lines = () => sent.map((one) => one.line);

describe("a kept command, every player online", () => {
    it("writes each run for whoever is on at that run", async () => {
        const result = await actions.repeatKeptCommandAction({
            installedAppId: INSTALL,
            id: KEPT,
            target: { every: true },
            repeat: EVERY_5S
        });
        expect(result.error).toBeUndefined();
        expect(result.repeats?.[0]).toMatchObject({ label: "Spawn piglin", total: 3, done: 0 });
        expect(audits).toContain("games.console.repeat");

        await vi.advanceTimersByTimeAsync(0);
        expect(lines()).toEqual(["/execute at Alex run summon minecraft:piglin_brute ~4 ~ ~"]);

        online = ["Alex", "Steve"];
        await vi.advanceTimersByTimeAsync(5_000);
        expect(lines().slice(1)).toEqual([
            "/execute at Alex run summon minecraft:piglin_brute ~4 ~ ~",
            "/execute at Steve run summon minecraft:piglin_brute ~4 ~ ~"
        ]);

        // Nobody on skips that run; the repeat goes on.
        online = [];
        await vi.advanceTimersByTimeAsync(5_000);
        expect(sent).toHaveLength(3);
        const [view] = (await actions.listConsoleRepeatsAction(INSTALL)).repeats;
        expect(view).toMatchObject({ done: 3, ended: "finished" });
        expect(english(view?.lastProblem)).toMatch(/nobody/i);
        // Every line ran as the person who started it.
        expect(sent.every((one) => one.actor === "u-ada")).toBe(true);
    });

    it("runs for the one player picked", async () => {
        online = ["Alex", "Steve"];
        await actions.repeatKeptCommandAction({
            installedAppId: INSTALL,
            id: KEPT,
            target: { player: "Steve" },
            repeat: { times: 2, every: 1, unit: "seconds" }
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(lines()).toEqual([
            "/execute at Steve run summon minecraft:piglin_brute ~4 ~ ~",
            "/execute at Steve run summon minecraft:piglin_brute ~4 ~ ~"
        ]);
    });

    it("refuses a per-player command with nobody chosen, and starts nothing", async () => {
        const result = await actions.repeatKeptCommandAction({
            installedAppId: INSTALL,
            id: KEPT,
            repeat: EVERY_5S
        });
        expect(result.error).toBeTruthy();
        expect(jobs.listRepeats(INSTALL)).toEqual([]);
    });
});

describe("a typed line", () => {
    it("is sent as typed, the number of times asked", async () => {
        const result = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "  time add 100  ",
            repeat: EVERY_5S
        });
        expect(result.error).toBeUndefined();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(lines()).toEqual(["time add 100", "time add 100", "time add 100"]);
    });

    it("is checked by the shared schema before anything runs", async () => {
        const result = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: { times: 500, every: 1, unit: "seconds" }
        });
        expect(result.error).toBe("Between 2 and 100 times");
        const fast = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: { times: 3, every: 0, unit: "seconds" }
        });
        expect(fast.error).toBe("At least 1 second apart");
        expect(jobs.listRepeats(INSTALL)).toEqual([]);
    });

    it("is refused on a server that is off", async () => {
        desiredState = "stopped";
        const result = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        expect(result.error).toBe("Start the server first");
        expect(jobs.listRepeats(INSTALL)).toEqual([]);
    });
});

describe("permission", () => {
    it("needs the console grant to start, see or stop one", async () => {
        consoleUsers = new Set();
        const started = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        expect(started.error).toBe("Server not found");
        expect(jobs.listRepeats(INSTALL)).toEqual([]);

        consoleUsers = new Set(["u-ada"]);
        const ok = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        const id = ok.repeats![0]!.id;
        consoleUsers = new Set();
        expect((await actions.listConsoleRepeatsAction(INSTALL)).repeats).toEqual([]);
        expect((await actions.stopConsoleRepeatAction(INSTALL, id)).error).toBe("Server not found");
        expect(jobs.listRepeats(INSTALL)[0]?.ended).toBeNull();
    });

    it("ends the repeat once whoever started it loses the console", async () => {
        await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        await vi.advanceTimersByTimeAsync(0);
        consoleUsers = new Set();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(lines()).toEqual(["say hi"]);
        expect(jobs.listRepeats(INSTALL)[0]).toMatchObject({ done: 1, ended: "noAccess" });
    });

    it("refuses starting them faster than anybody would by hand", async () => {
        allowed = false;
        const result = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        expect(result.error).toBe("Too many repeats started. Try again in a minute.");
        expect(jobs.listRepeats(INSTALL)).toEqual([]);
    });
});

describe("the server's own life", () => {
    it("ends when the server restarts between runs", async () => {
        await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        await vi.advanceTimersByTimeAsync(0);
        boot = "2026-10-25T10:05:00Z";
        await vi.advanceTimersByTimeAsync(5_000);
        expect(lines()).toEqual(["say hi"]);
        expect(jobs.listRepeats(INSTALL)[0]).toMatchObject({ ended: "serverStopped" });
    });

    it("ends when the server is turned off between runs", async () => {
        await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        await vi.advanceTimersByTimeAsync(0);
        desiredState = "stopped";
        await vi.advanceTimersByTimeAsync(5_000);
        expect(lines()).toEqual(["say hi"]);
        expect(jobs.listRepeats(INSTALL)[0]).toMatchObject({ ended: "serverStopped" });
    });
});

describe("stopping", () => {
    it("is open to anybody with the console, and recorded", async () => {
        const started = await actions.repeatConsoleLineAction({
            installedAppId: INSTALL,
            line: "say hi",
            repeat: EVERY_5S
        });
        await vi.advanceTimersByTimeAsync(0);
        const result = await actions.stopConsoleRepeatAction(INSTALL, started.repeats![0]!.id);
        expect(result.repeats?.[0]).toMatchObject({ ended: "stopped", done: 1 });
        expect(audits).toContain("games.console.repeat.stop");
        await vi.advanceTimersByTimeAsync(20_000);
        expect(lines()).toEqual(["say hi"]);
    });
});
