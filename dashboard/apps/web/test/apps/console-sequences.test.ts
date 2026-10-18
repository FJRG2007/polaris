/**
 * A kept console command that is a sequence of several.
 *
 * Pinned: a sequence is stored as its lines, each trimmed and the empty ones
 * dropped, and held to what "Run several" would run; a single line keeps every
 * rule it had, `wait 10` on its own included; a command kept before sequences
 * existed reads back unchanged; and when one runs, a variable declared once -
 * `{x=100}` on its first line - is asked once and filled into every line, a
 * per-player line is written for each player in place, and a pause is kept as a
 * step for the console but refused by the path that sends in one go.
 */

import { english } from "../setup/game-english";
import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: { readInstallConfig: () => ({}), patchInstallConfig: async () => {} },
        mcp: { actingUser: async () => null },
        appsInstallAccess: { gameServerAccess: async () => null }
    }
}));
const sent: string[] = [];
vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    runConsoleCommand: async (_actor: unknown, _server: unknown, line: string) => {
        sent.push(line);
        return "ok";
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    shownPlayers: async () => ({ players: ["Alex", "Steve"] })
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-values", () => ({
    liveContext: async () => ({ values: {}, recipients: null })
}));

const commands = await import("@polaris-app/game-servers/src/lib/console-commands");
const { keptCommandLines, keptCommandSteps, runKeptCommand } = await import(
    "@polaris-app/game-servers/src/lib/console-run-service"
);
const { commandVariables, needsAsking } = await import(
    "@polaris-app/game-servers/src/lib/console-vars"
);

const MINECRAFT = {
    ownerId: "owner",
    install: { id: "install", catalogId: "minecraft", applicationId: "app" }
};
const ARK = { ownerId: "owner", install: { id: "install", catalogId: "ark", applicationId: "app" } };

describe("keeping a sequence", () => {
    it("normalizes the text the same way on both sides", () => {
        expect(commands.normalizeCommandText("  a \r\n\r\n b\n\n")).toBe("a\nb");
        expect(commands.normalizeCommandText(" SaveWorld ")).toBe("SaveWorld");
    });

    it("tells a sequence from a single command, and counts what it sends", () => {
        const block = "say one\n# a note\nwait 5\nsay two";
        expect(commands.isSequence(block)).toBe(true);
        expect(commands.keptCommandCount(block)).toBe(2);
        expect(commands.hasPauses(block)).toBe(true);
        expect(commands.hasPauses("say one\nsay two")).toBe(false);
        expect(commands.commandPreview("say one\nsay two")).toBe("say one | say two");
        expect(commands.isSequence("SaveWorld")).toBe(false);
        expect(commands.keptCommandCount("SaveWorld")).toBe(1);
    });

    it("keeps a single line to the rules it always had", () => {
        // On its own, `wait 10` is a command like any other, as it always was.
        expect(commands.normalizeSavedCommand({ id: "a", command: "wait 10" })?.command).toBe(
            "wait 10"
        );
        expect(commands.savedCommandProblem("x".repeat(400))).toBeNull();
        expect(english(commands.savedCommandProblem("x".repeat(401))!)).toBe(
            "Line 1 is longer than the 400 characters the server takes in one command."
        );
    });

    it("bounds a sequence by its lines, its length and what Run several takes", () => {
        const lines = (count: number) =>
            Array.from({ length: count }, (_, at) => `say ${at}`).join("\n");
        expect(commands.savedCommandProblem(lines(commands.MAX_SAVED_LINES))).toBeNull();
        expect(english(commands.savedCommandProblem(lines(commands.MAX_SAVED_LINES + 1))!)).toBe(
            "A kept sequence holds up to 20 lines."
        );
        const long = Array.from({ length: 11 }, () => `say ${"x".repeat(390)}`).join("\n");
        expect(english(commands.savedCommandProblem(long)!)).toBe(
            "That sequence is longer than 4000 characters."
        );
        expect(english(commands.savedCommandProblem("say a\nwait 500")!)).toBe(
            "Line 2 waits longer than 120 seconds. Use the Schedule tab for that."
        );
        expect(english(commands.savedCommandProblem("# only\n# notes")!)).toBe(
            "There is no command in that."
        );
        expect(commands.normalizeSavedCommand({ id: "a", command: "say a\nwait 500" })).toBeNull();
    });

    it("reads back a command kept before sequences, unchanged", () => {
        const old = [{ id: "a", label: "Save", command: "SaveWorld" }];
        expect(commands.readSavedCommands({ consoleCommands: old })).toEqual(old);
        const both = [...old, { id: "b", label: "Restart", command: "say bye\nwait 5\nstop" }];
        expect(commands.readSavedCommands({ consoleCommands: both })).toEqual(both);
    });
});

describe("running a sequence", () => {
    it("asks once for a variable declared on one line and fills it into every line", async () => {
        const command = "say Restart in {x=10}s\nwait 5\ntitle @a title {x}";
        const asked = commandVariables(command, []).custom;
        expect(asked.map((one) => [one.name, one.initial])).toEqual([["x", "10"]]);
        expect(needsAsking(command, "java", [])).toBe(true);

        const steps = await keptCommandSteps(ARK, {
            command,
            variables: [],
            values: { x: "30" },
            target: null
        });
        expect(steps).toEqual([
            { kind: "command", line: "say Restart in 30s" },
            { kind: "wait", ms: 5000 },
            { kind: "command", line: "title @a title 30" }
        ]);
        // Left empty, the default declared on the first line fills both.
        const fallback = await keptCommandSteps(ARK, {
            command,
            variables: [],
            values: {},
            target: null
        });
        expect(fallback.flatMap((step) => (step.kind === "command" ? [step.line] : []))).toEqual([
            "say Restart in 10s",
            "title @a title 10"
        ]);
    });

    it("writes a per-player line for each player, in its place in the sequence", async () => {
        const steps = await keptCommandSteps(MINECRAFT, {
            command: "say Heads up\ntp {player} 0 64 0\nsay Done",
            variables: [],
            values: {},
            target: { every: true }
        });
        expect(steps).toEqual([
            { kind: "command", line: "say Heads up" },
            { kind: "command", line: "tp Alex 0 64 0" },
            { kind: "command", line: "tp Steve 0 64 0" },
            { kind: "command", line: "say Done" }
        ]);
    });

    it("sends a sequence without pauses in one go, and refuses one with them", async () => {
        sent.length = 0;
        const replies = await runKeptCommand("u1", ARK, {
            command: "say a\n# note\n/say b",
            variables: [],
            values: {},
            target: null
        });
        expect(sent).toEqual(["say a", "say b"]);
        expect(replies.every((reply) => !reply.failed)).toBe(true);
        await expect(
            keptCommandLines(ARK, {
                command: "say a\nwait 2\nsay b",
                variables: [],
                values: {},
                target: null
            })
        ).rejects.toThrow();
    });

    it("runs a single command exactly as before", async () => {
        expect(
            await keptCommandLines(ARK, {
                command: "SpawnDino {dino=Rex}",
                variables: [],
                values: {},
                target: null
            })
        ).toEqual(["SpawnDino Rex"]);
    });
});
