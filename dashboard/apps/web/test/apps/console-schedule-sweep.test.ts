/**
 * The minute sweep firing a scheduled console command.
 *
 * Pinned: a due command goes through the console's own path, as the person who
 * scheduled it, with its values filled in; a server that did not answer has
 * the moment skipped and written down, never queued; a schedule stopped
 * while the sweep was running stays stopped; and one whose author has lost the
 * console ends instead of running in their name.
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

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({
                id: INSTALL,
                catalogId: "ark",
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
        return "ok";
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    shownPlayers: async () => null
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-values", () => ({
    liveContext: async () => ({ values: {}, recipients: null })
}));

const { runConsoleSchedules } = await import(
    "@polaris-app/game-servers/src/lib/console-run-service"
);

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
});
