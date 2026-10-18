/**
 * Keeping and running a kept sequence, as the server takes it.
 *
 * Pinned: a sequence is stored with every line trimmed and the empty ones
 * dropped, and refused with the reason when "Run several" would refuse it; a
 * single command is stored as it always was; the steps of a sequence are handed
 * back for the console to run, its values checked first and nothing sent; and a
 * sequence that pauses is never scheduled, because the sweep runs a schedule in
 * one go.
 */

import { english } from "../setup/game-english";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedCommand } from "@polaris-app/game-servers/src/lib/console-commands";
import type { ConsoleSchedule } from "@polaris-app/game-servers/src/lib/console-schedule";

const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const ID = "bbbbbbbb-1111-4111-8111-111111111111";
let kept: SavedCommand[] = [];
const added: ConsoleSchedule[] = [];
const sent: string[] = [];

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/app-host", () => ({
    host: {
        auditService: { recordAudit: async () => undefined },
        appsInstallConfig: { readInstallConfig: () => ({}), patchInstallConfig: async () => {} },
        mcp: { actingUser: async () => null },
        appsInstallAccess: {
            gameServerAccess: async () => null,
            requireGameServer: async () => ({
                user: { id: "u1" },
                access: {
                    ownerId: "owner",
                    install: { id: INSTALL, catalogId: "ark", applicationId: "app" }
                }
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
    readConsoleCommands: async () => kept,
    saveConsoleCommand: async (_id: string, entry: SavedCommand) => {
        kept = [...kept.filter((one) => one.id !== entry.id), entry];
        return kept;
    },
    addConsoleSchedule: async (_id: string, schedule: ConsoleSchedule) => {
        added.push(schedule);
        return [schedule];
    },
    deleteConsoleCommand: async () => [],
    readConsoleSchedulesOf: async () => [],
    removeConsoleSchedule: async () => []
}));

vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    runConsoleCommand: async (_actor: unknown, _server: unknown, line: string) => {
        sent.push(line);
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

const actions = await import("@polaris-app/game-servers/src/screens/installed/console-actions");

beforeEach(() => {
    kept = [];
    added.length = 0;
    sent.length = 0;
});

describe("keeping a sequence", () => {
    it("stores every line trimmed, the empty ones dropped", async () => {
        const result = await actions.saveConsoleCommandAction({
            installedAppId: INSTALL,
            id: ID,
            label: "Restart",
            command: "  say Restarting  \n\n\r\nwait 5\n  stop  \n"
        });
        expect(result.error).toBeUndefined();
        expect(result.commands?.[0]?.command).toBe("say Restarting\nwait 5\nstop");
    });

    it("stores a single command as it always did", async () => {
        const result = await actions.saveConsoleCommandAction({
            installedAppId: INSTALL,
            command: "  SaveWorld  "
        });
        expect(result.commands?.[0]).toMatchObject({ label: "SaveWorld", command: "SaveWorld" });
    });

    it("refuses one Run several would refuse, saying why", async () => {
        const result = await actions.saveConsoleCommandAction({
            installedAppId: INSTALL,
            command: "say a\nwait 999"
        });
        expect(result.error).toBe(
            "Line 2 waits longer than 120 seconds. Use the Schedule tab for that."
        );
        const blank = await actions.saveConsoleCommandAction({
            installedAppId: INSTALL,
            command: " \n \n"
        });
        expect(blank.error).toBe("There is no command in that.");
        expect(kept).toEqual([]);
    });
});

describe("running a sequence", () => {
    it("hands back its steps filled in, and sends nothing itself", async () => {
        kept = [{ id: ID, label: "Warn", command: "say in {x=10}s\nwait 3\nsay {x}" }];
        const result = await actions.keptStepsAction({
            installedAppId: INSTALL,
            id: ID,
            values: { x: "20" }
        });
        expect(result.steps).toEqual([
            { kind: "command", line: "say in 20s" },
            { kind: "wait", ms: 3000 },
            { kind: "command", line: "say 20" }
        ]);
        expect(sent).toEqual([]);
    });

    it("checks the values it is given", async () => {
        kept = [
            {
                id: ID,
                label: "Warn",
                command: "say {x}\nsay {x}",
                variables: [{ name: "x", label: "Seconds", type: "number", initial: "" }]
            }
        ];
        const result = await actions.keptStepsAction({
            installedAppId: INSTALL,
            id: ID,
            values: { x: "soon" }
        });
        expect(result.error).toMatch(/^Seconds: /);
    });

    it("never schedules a sequence that pauses, and schedules one that does not", async () => {
        kept = [
            { id: ID, label: "Warn", command: "say a\nwait 3\nsay b" },
            { id: "plain", label: "Both", command: "say a\nsay b" }
        ];
        const paused = await actions.scheduleKeptCommandAction({
            installedAppId: INSTALL,
            id: ID,
            repeat: { kind: "once" }
        });
        expect(paused.error).toBe(
            "A sequence with pauses runs only from the console, not on a schedule."
        );
        const plain = await actions.scheduleKeptCommandAction({
            installedAppId: INSTALL,
            id: "plain",
            repeat: { kind: "once" }
        });
        expect(plain.error).toBeUndefined();
        expect(added.map((one) => one.command)).toEqual(["say a\nsay b"]);
    });
});
