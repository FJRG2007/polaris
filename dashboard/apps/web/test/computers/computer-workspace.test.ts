import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/computers/computer-commands", () => ({ sendToRunner: vi.fn() }));
vi.mock("@/lib/computers/computer-bus", () => ({ onRunnerLive: vi.fn(), publishRunnerLive: vi.fn() }));

const { readComputerWorkspace, deliverWorkspaceAnswer } = await import("@/lib/computers/computer-workspace");
const { computerChanges, computerDiff } = await import("@/lib/agents/session-review");
const { computerFile } = await import("@/lib/agents/session-files");

const RUNNER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e51";
const OTHER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e52";
const SESSION = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e53";

function fakeDeps(features: string[] | null, sent = true) {
    const commands: { runnerId: string; command: { requestId?: string } }[] = [];
    return {
        commands,
        deps: {
            features: async () => features,
            send: async (runnerId: string, command: unknown) => {
                commands.push({ runnerId, command: command as { requestId?: string } });
                return sent;
            },
            listen: () => undefined,
            timeoutMs: 50
        }
    };
}

describe("readComputerWorkspace", () => {
    it("asks nothing of a runner without workspace-read", async () => {
        const { deps, commands } = fakeDeps(["toolchain"]);
        expect(await readComputerWorkspace({ id: SESSION, runnerId: RUNNER }, { kind: "files" }, deps)).toBeNull();
        expect(commands).toHaveLength(0);
    });

    it("takes the answer from the runner it asked, not another", async () => {
        const { deps, commands } = fakeDeps(["workspace-read"]);
        const read = readComputerWorkspace({ id: SESSION, runnerId: RUNNER }, { kind: "files" }, deps);
        await vi.waitFor(() => expect(commands).toHaveLength(1));
        const requestId = commands[0]!.command.requestId!;
        const publish = vi.fn(async () => undefined);
        expect(deliverWorkspaceAnswer(OTHER, requestId, { kind: "missing" }, publish)).toBe(false);
        expect(publish).not.toHaveBeenCalled();
        expect(deliverWorkspaceAnswer(RUNNER, requestId, { kind: "files", paths: ["a.ts"], truncated: false }, publish)).toBe(true);
        expect(await read).toEqual({ kind: "files", paths: ["a.ts"], truncated: false });
    });

    it("answers null when the command is not sent or nobody answers", async () => {
        expect(await readComputerWorkspace({ id: SESSION, runnerId: RUNNER }, { kind: "files" }, fakeDeps(["workspace-read"], false).deps)).toBeNull();
        expect(await readComputerWorkspace({ id: SESSION, runnerId: RUNNER }, { kind: "files" }, fakeDeps(["workspace-read"]).deps)).toBeNull();
    });

    it("hands an answer for a read held elsewhere to the other nodes", () => {
        const publish = vi.fn(async () => undefined);
        expect(deliverWorkspaceAnswer(RUNNER, SESSION, { kind: "missing" }, publish)).toBe(false);
        expect(publish).toHaveBeenCalledWith({ k: "workspace", runnerId: RUNNER, requestId: SESSION, answer: { kind: "missing" } });
    });
});

describe("computer answers in the readers' words", () => {
    it("maps changes, diffs and files", () => {
        expect(computerChanges({ kind: "changes", base: "abc1234", total: 1, files: [{ path: "a", added: 1, removed: null }], next: null }))
            .toEqual({ kind: "listing", listing: { kind: "ok", base: "abc1234", total: 1, files: [{ path: "a", added: 1, removed: null }], next: null } });
        expect(computerChanges(null)).toEqual({ kind: "unreachable" });
        expect(computerDiff({ kind: "diffLarge", size: 9 })).toEqual({ kind: "diff", diff: { kind: "large", size: 9 } });
        expect(computerDiff({ kind: "nobase" })).toEqual({ kind: "diff", diff: { kind: "nobase" } });
        expect(computerFile({ kind: "gone", path: "a" }, "a")).toEqual({ kind: "missing", path: "a" });
        expect(computerFile(null, "a")).toEqual({ kind: "unavailable" });
    });
});
