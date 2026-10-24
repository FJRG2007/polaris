/**
 * Scheduling a kept command, as the server takes it.
 *
 * Pinned: "in so many minutes, hours or days" is counted on the server's clock,
 * not the browser's, and wins over a moment sent beside it; the same schema the
 * dialog uses refuses a delay out of bounds or in a unit finer than the sweep;
 * a schedule sent the old way, with only a moment, still works.
 */

import { english } from "../setup/game-english";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleSchedule } from "@polaris-app/game-servers/src/lib/console-schedule";

const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-11T12:00:00.000Z");
const added: ConsoleSchedule[] = [];

// Loaded through the repeat actions beside the schedule ones; never reached here.
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    runConsoleCommand: async () => "ok"
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        auditService: { recordAudit: async () => undefined },
        appsInstallAccess: {
            requireGameServer: async () => ({
                user: { id: "u1" },
                access: { install: { id: INSTALL } }
            })
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/screens/game-words", () => ({
    gameWords: async () => (key: string) => key,
    issueText: async (message: string | undefined) => (message ? english(message) : undefined),
    messageText: async (message: string) => english(message)
}));

vi.mock("@polaris-app/game-servers/src/lib/console-command-service", () => ({
    readConsoleCommands: async () => [{ id: "c1", label: "Save", command: "save-all" }],
    addConsoleSchedule: async (_id: string, schedule: ConsoleSchedule) => {
        added.push(schedule);
        return [schedule];
    },
    deleteConsoleCommand: async () => [],
    readConsoleSchedulesOf: async () => [],
    removeConsoleSchedule: async () => [],
    saveConsoleCommand: async () => []
}));

vi.mock("@polaris-app/game-servers/src/lib/console-run-service", () => ({
    keptRunProblem: () => null,
    runKeptCommand: async () => []
}));

const { scheduleKeptCommandAction } = await import(
    "@polaris-app/game-servers/src/screens/installed/console-actions"
);

beforeEach(() => {
    added.length = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
});

const base = { installedAppId: INSTALL, id: "c1", repeat: { kind: "once" } as const };

describe("scheduling a kept command", () => {
    it("counts an 'in ...' from the server's own now, over the browser's moment", async () => {
        const result = await scheduleKeptCommandAction({
            ...base,
            // A browser clock an hour off.
            firstAt: "2026-10-11T13:00:00.000Z",
            startIn: { amount: 15, unit: "minutes" }
        });
        expect(result.error).toBeUndefined();
        expect(added[0]?.nextAt).toBe("2026-10-11T12:15:00.000Z");
    });

    it("takes hours and days", async () => {
        await scheduleKeptCommandAction({ ...base, startIn: { amount: 2, unit: "days" } });
        expect(added[0]?.nextAt).toBe("2026-10-13T12:00:00.000Z");
    });

    it("still takes a moment on its own", async () => {
        await scheduleKeptCommandAction({ ...base, firstAt: "2026-10-11T18:30:00.000Z" });
        expect(added[0]?.nextAt).toBe("2026-10-11T18:30:00.000Z");
    });

    it("refuses a delay out of bounds, or in seconds", async () => {
        for (const startIn of [
            { amount: 0, unit: "minutes" },
            { amount: 1.5, unit: "hours" },
            { amount: 367, unit: "days" }
        ] as const) {
            const result = await scheduleKeptCommandAction({ ...base, startIn });
            expect(result.error).toBe("Whole minutes, hours or days, up to a year");
        }
        const seconds = await scheduleKeptCommandAction({
            ...base,
            startIn: { amount: 30, unit: "seconds" as "minutes" }
        });
        expect(seconds.error).toBeTruthy();
        expect(added).toHaveLength(0);
    });

    it("stores a repeat typed in days as minutes", async () => {
        await scheduleKeptCommandAction({
            ...base,
            startIn: { amount: 1, unit: "minutes" },
            repeat: { kind: "every", minutes: 3 * 24 * 60 }
        });
        expect(added[0]?.repeat).toEqual({ kind: "every", minutes: 4320 });
    });
});
