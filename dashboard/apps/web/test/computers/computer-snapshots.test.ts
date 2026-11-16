import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/computers/computer-commands", () => ({ sendToRunner: vi.fn() }));
vi.mock("@/lib/computers/computer-bus", () => ({ onRunnerLive: vi.fn(), publishRunnerLive: vi.fn() }));

const { runComputerSnapshot, deliverSnapshotAnswer, deliverWorkspaceAnswer } = await import("@/lib/computers/computer-workspace");
const { computerStep, computerTurns } = await import("@/lib/agents/session-snapshot-service");

const RUNNER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e51";
const SESSION = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e53";
const COMMIT = "c".repeat(40);

function fakeDeps(features: string[] | null) {
    const commands: { type: string; requestId: string; action?: unknown }[] = [];
    return {
        commands,
        deps: {
            features: async () => features,
            send: async (_runnerId: string, command: unknown) => {
                commands.push(command as { type: string; requestId: string });
                return true;
            },
            listen: () => undefined,
            timeoutMs: 50
        }
    };
}

describe("runComputerSnapshot", () => {
    it("asks nothing of a desktop that predates snapshots", async () => {
        const { deps, commands } = fakeDeps(["workspace-read", "transcript-read"]);
        expect(await runComputerSnapshot({ id: SESSION, runnerId: RUNNER }, { kind: "list" }, deps)).toBeNull();
        expect(commands).toHaveLength(0);
    });

    it("sends the step and takes only a snapshot answer for it", async () => {
        const { deps, commands } = fakeDeps(["workspace-snapshot"]);
        const step = runComputerSnapshot({ id: SESSION, runnerId: RUNNER }, { kind: "undo", to: COMMIT }, deps);
        await vi.waitFor(() => expect(commands).toHaveLength(1));
        expect(commands[0]).toMatchObject({ type: "snapshot.run", sessionId: SESSION, action: { kind: "undo", to: COMMIT } });
        const requestId = commands[0]!.requestId;
        const publish = vi.fn(async () => undefined);
        // A workspace answer under the same id is not this read's.
        expect(deliverWorkspaceAnswer(RUNNER, requestId, { kind: "missing" }, publish)).toBe(false);
        expect(deliverSnapshotAnswer(RUNNER, requestId, { kind: "undone", id: COMMIT }, publish)).toBe(true);
        expect(await step).toEqual({ kind: "undone", id: COMMIT });
    });

    it("hands an answer for a step held elsewhere to the other nodes", () => {
        const publish = vi.fn(async () => undefined);
        expect(deliverSnapshotAnswer(RUNNER, SESSION, { kind: "restored" }, publish)).toBe(false);
        expect(publish).toHaveBeenCalledWith({ k: "snapshot", runnerId: RUNNER, requestId: SESSION, answer: { kind: "restored" } });
    });
});

describe("computer snapshot answers in the screen's words", () => {
    it("maps listings and steps", () => {
        expect(computerTurns({ kind: "list", turns: [{ id: COMMIT, at: 1, label: "Fix" }], undone: COMMIT })).toEqual({
            kind: "listing",
            listing: { turns: [{ id: COMMIT, at: 1, label: "Fix" }], undone: COMMIT }
        });
        expect(computerTurns({ kind: "nocheckout" })).toEqual({ kind: "unavailable", reason: "workspace" });
        expect(computerTurns(null)).toEqual({ kind: "unreachable" });
        expect(computerStep({ kind: "undone", id: COMMIT })).toEqual({ kind: "done", result: { kind: "undone", id: COMMIT } });
        expect(computerStep({ kind: "stale" })).toEqual({ kind: "done", result: { kind: "stale" } });
        expect(computerStep({ kind: "missing" })).toEqual({ kind: "unavailable", reason: "ended" });
        expect(computerStep({ kind: "list", turns: [], undone: null })).toEqual({ kind: "unreachable" });
    });
});
