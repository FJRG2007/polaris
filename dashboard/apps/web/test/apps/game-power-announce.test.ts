/**
 * Starting or stopping a game server from its own screen, an assistant or an
 * automation step goes through one function, and that is where the automations
 * listening for "Game server started/stopped" hear about it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const announced: unknown[][] = [];
const running: unknown[][] = [];
let announceFails = false;

vi.mock("@polaris/app-host", () => ({
    host: {
        deployService: {
            setApplicationRunning: async (...args: unknown[]) => void running.push(args)
        },
        auditService: { recordAudit: async () => undefined },
        automations: {
            announceGameServer: async (...args: unknown[]) => {
                if (announceFails) throw new Error("outbox down");
                announced.push(args);
            }
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/games-flush", () => ({
    flushGameWorld: async () => undefined
}));
vi.mock("@polaris-app/game-servers/src/lib/duplicate-busy", () => ({
    refuseWhileCopying: async () => undefined
}));
vi.mock("@polaris-app/game-servers/src/lib/games-health", () => ({
    clearCrashLoop: async () => undefined
}));
vi.mock("@polaris-app/game-servers/src/lib/console-repeat-jobs", () => ({
    endRepeatsOn: () => undefined
}));
vi.mock("@polaris-app/game-servers/src/lib/games-restart-service", () => ({
    runRestartNow: async () => undefined
}));
vi.mock("@polaris-app/game-servers/src/lib/ark/service", () => ({ runArkCommand: async () => "" }));
vi.mock("@polaris-app/game-servers/src/lib/fivem/service", () => ({
    runFivemCommand: async () => ""
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    runConsoleLine: async () => ""
}));

const { setServerRunning } = await import("@polaris-app/game-servers/src/lib/games-operations");

const access = {
    ownerId: "owner",
    install: { id: "install-1", catalogId: "minecraft", applicationId: "app-1" }
};

beforeEach(() => {
    announced.length = 0;
    running.length = 0;
    announceFails = false;
});

describe("game server power switch", () => {
    it("tells the automations once it has started or stopped", async () => {
        await setServerRunning({ id: "user" }, access, true);
        await setServerRunning({ id: "user" }, access, false);
        expect(running).toEqual([
            ["app-1", "owner", true, "user"],
            ["app-1", "owner", false, "user"]
        ]);
        expect(announced).toEqual([
            ["owner", "install-1", true],
            ["owner", "install-1", false]
        ]);
    });

    it("never fails the switch over an automation", async () => {
        announceFails = true;
        await expect(setServerRunning({ id: "user" }, access, true)).resolves.toBeUndefined();
        expect(running).toHaveLength(1);
    });
});
