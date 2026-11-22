/**
 * The minute sweep firing a scheduled console command.
 *
 * Pinned: a due command goes through the console's own path, as the person who
 * scheduled it, with its values filled in; a server that did not answer has
 * the moment skipped and written down, never queued; a schedule stopped
 * while the sweep was running stays stopped; and one whose author has lost the
 * console ends instead of running in their name. A line a Java server refuses
 * in words is a failed run, not a ran one; and a run with pauses is held in the
 * background, shown as running, its outcome written when it ends.
 */

import { english } from "../setup/game-english";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleSchedule } from "@polaris-app/game-servers/src/lib/console-schedule";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:30.000Z");

let config: Record<string, unknown> = {};
/** What the sweep reads before it writes, so a test can change it in between. */
let beforeWrite: () => void = () => undefined;
const sent: { actor: string; line: string }[] = [];
/** Who still has the console on the server. */
let consoleUsers = new Set<string>();
/** Which game the server is, and what it answers each line. */
let catalog = "ark";
let answer: (line: string) => string = () => "ok";

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({
                id: INSTALL,
                catalogId: catalog,
                applicationId: "app",
                config: JSON.stringify(config)
            }),
            findUnique: async () => {
                beforeWrite();
                return { config: JSON.stringify(config) };
            }
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: unknown) =>
                typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {},
            patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
                config = { ...config, ...patch };
            }
        },
        mcp: {
            actingUser: async (id: string) => (id === "u-gone" ? null : { id })
        },
        appsInstallAccess: {
            gameServerAccess: async (user: { id: string }, id: string, permission: string) =>
                id === INSTALL && permission === "games.console" && consoleUsers.has(user.id)
                    ? { install: { id } }
                    : null
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    runConsoleCommand: async (actor: { id: string }, _server: unknown, line: string) => {
        sent.push({ actor: actor.id, line });
        return answer(line);
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    shownPlayers: async () => null
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-values", () => ({
    liveContext: async () => ({ values: {}, recipients: null })
}));

const { runConsoleSchedules } =
    await import("@polaris-app/game-servers/src/lib/console-run-service");

const schedule = (patch: Partial<ConsoleSchedule> = {}): ConsoleSchedule => ({
    id: "22222222-1111-4111-8111-111111111111",
    commandId: "c1",
    label: "Dinos",
    command: "SpawnDino {dino} {level}",
    variables: [
        { name: "dino", label: "Dino", type: "text", initial: "" },
        { name: "level", label: "Level", type: "number", initial: "" }
    ],
    values: { dino: "Rex", level: "150" },
    target: null,
    repeat: { kind: "every", minutes: 5 },
    nextAt: "2026-10-11T12:00:00.000Z",
    done: 0,
    skipped: 0,
    last: null,
    createdBy: "u-ada",
    ...patch
});

const stored = () => config.consoleSchedules as ConsoleSchedule[];

beforeEach(() => {
    sent.length = 0;
    beforeWrite = () => undefined;
    consoleUsers = new Set(["u-ada"]);
    catalog = "ark";
    answer = () => "ok";
    config = { consoleSchedules: [schedule()] };
});

describe("the sweep", () => {
    it("runs a due command through the console, as whoever scheduled it", async () => {
        expect(await runConsoleSchedules(OWNER, INSTALL, true, NOW)).toBe(1);
        expect(sent).toEqual([{ actor: "u-ada", line: "SpawnDino Rex 150" }]);
        expect(stored()[0]).toMatchObject({
            done: 1,
            skipped: 0,
            nextAt: "2026-10-11T12:05:00.000Z",
            last: { outcome: "ran" }
        });
    });

    it("skips the moment on a server that did not answer, and says why", async () => {
        expect(await runConsoleSchedules(OWNER, INSTALL, false, NOW)).toBe(0);
        expect(sent).toEqual([]);
        expect(stored()[0]).toMatchObject({
            done: 1,
            skipped: 1,
            nextAt: "2026-10-11T12:05:00.000Z"
        });
        expect(english(stored()[0]?.last?.detail)).toBe("The server was offline");
    });

    it("does nothing before the moment", async () => {
        config = { consoleSchedules: [schedule({ nextAt: "2026-10-11T12:10:00.000Z" })] };
        expect(await runConsoleSchedules(OWNER, INSTALL, true, NOW)).toBe(0);
        expect(stored()[0]?.done).toBe(0);
    });

    it("leaves a schedule stopped while the command ran stopped", async () => {
        beforeWrite = () => {
            config = { consoleSchedules: [] };
        };
        await runConsoleSchedules(OWNER, INSTALL, true, NOW);
        expect(stored()).toEqual([]);
    });

    it("ends a schedule whose author no longer has the console, without running it", async () => {
        consoleUsers = new Set();
        expect(await runConsoleSchedules(OWNER, INSTALL, true, NOW)).toBe(0);
        expect(sent).toEqual([]);
        expect(stored()[0]).toMatchObject({ nextAt: null, last: { outcome: "failed" } });
        expect(english(stored()[0]?.last?.detail)).toBe(
            "Whoever set it up can no longer use the console"
        );
    });

    it("ends a schedule whose author's account is gone", async () => {
        config = { consoleSchedules: [schedule({ createdBy: "u-gone" })] };
        await runConsoleSchedules(OWNER, INSTALL, false, NOW);
        expect(sent).toEqual([]);
        expect(stored()[0]).toMatchObject({ nextAt: null, last: { outcome: "failed" } });
    });

    const REFUSAL = [
        "Invalid or unknown entity type 'feralzombie:predator'",
        "...@e[type=feralzombie:predator]<--[HERE]"
    ].join("\n");

    it("fails a run a Java server refused in words, with the server's text", async () => {
        catalog = "minecraft";
        answer = () => REFUSAL;
        expect(await runConsoleSchedules(OWNER, INSTALL, true, NOW)).toBe(0);
        expect(stored()[0]?.last).toMatchObject({ outcome: "failed", detail: REFUSAL });
    });

    it("leaves another game's answer as it stands", async () => {
        answer = () => REFUSAL;
        expect(await runConsoleSchedules(OWNER, INSTALL, true, NOW)).toBe(1);
        expect(stored()[0]?.last?.outcome).toBe("ran");
    });

    const paused = (command: string) => schedule({ command, variables: [], values: {} });

    it("holds a run's pauses in the background and writes its outcome when it ends", async () => {
        config = { consoleSchedules: [paused("wait 0.05\nsay a\nwait 0.05\nsay b")] };
        await runConsoleSchedules(OWNER, INSTALL, true, NOW);
        expect(stored()[0]?.last?.outcome).toBe("running");
        await vi.waitFor(() => expect(stored()[0]?.last?.outcome).toBe("ran"));
        expect(sent.map((one) => one.line)).toEqual(["say a", "say b"]);
        expect(stored()[0]?.last?.at).toBe(NOW.toISOString());
    });

    it("skips the next moment while the last run is still going", async () => {
        config = { consoleSchedules: [paused("wait 0.3\nsay a")] };
        await runConsoleSchedules(OWNER, INSTALL, true, NOW);
        await runConsoleSchedules(OWNER, INSTALL, true, new Date(NOW.getTime() + 5 * 60_000));
        expect(stored()[0]?.last?.outcome).toBe("skipped");
        expect(english(stored()[0]?.last?.detail)).toBe("The previous run is still going.");
        await vi.waitFor(() => expect(sent.map((one) => one.line)).toEqual(["say a"]));
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The first run's outcome is not written over the moment after it.
        expect(stored()[0]?.last?.outcome).toBe("skipped");
    });

    it("fails a run whose pauses add up to more than a scheduled run may wait", async () => {
        const long = Array.from({ length: 6 }, (_, at) => `say ${at}\nwait 120`).join("\n");
        config = { consoleSchedules: [paused(long)] };
        await runConsoleSchedules(OWNER, INSTALL, true, NOW);
        expect(stored()[0]?.last?.outcome).toBe("failed");
        expect(english(stored()[0]?.last?.detail)).toMatch(/600 seconds in all/);
        expect(sent).toEqual([]);
    });
});
