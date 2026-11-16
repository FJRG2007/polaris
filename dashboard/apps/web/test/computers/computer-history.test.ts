/**
 * History on a computer: the transcript is asked of the desktop a chunk at a
 * time (`transcript.read`), from a path that may be a Windows one, read by the
 * same line logic as a container's, and stored once per line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    sessionId: string;
    role: string;
    body: string;
    vendorId: string | null;
}

const db = vi.hoisted(() => ({
    session: null as null | Record<string, unknown>,
    messages: [] as { sessionId: string; role: string; body: string; vendorId: string | null }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: vi.fn(async () => (db.session ? { ...db.session } : null)),
            updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                if (!db.session || where.id !== db.session.id) return { count: 0 };
                if ("transcriptOffset" in where && where.transcriptOffset !== db.session.transcriptOffset) return { count: 0 };
                Object.assign(db.session, data);
                return { count: 1 };
            })
        },
        agentSessionMessage: {
            findMany: vi.fn(async ({ where }: { where: { vendorId?: { in: string[] } } }) =>
                where.vendorId ? db.messages.filter((one) => where.vendorId!.in.includes(one.vendorId ?? "")) : []
            ),
            updateMany: vi.fn(async () => ({ count: 0 })),
            createMany: vi.fn(async ({ data }: { data: Row[] }) => {
                db.messages.push(...data.map(({ sessionId, role, body, vendorId }) => ({ sessionId, role, body, vendorId })));
                return { count: data.length };
            })
        }
    }
}));
vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: vi.fn(async () => ({ code: 1, output: "" })) }));
vi.mock("@/lib/agents/session-live", () => ({ touchSession: vi.fn() }));
vi.mock("@/lib/agents/session-usage", () => ({ claudeLineUsage: () => null, recordSessionUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/codex-turn-failures", () => ({ noteCodexTurnEnd: vi.fn() }));
vi.mock("@/lib/computers/computer-commands", () => ({ sendToRunner: vi.fn() }));
vi.mock("@/lib/computers/computer-bus", () => ({ onRunnerLive: vi.fn(), publishRunnerLive: vi.fn() }));

const core = await import("@polaris/core");
const { syncSessionHistory, computerTranscriptAnswer } = await import("@/lib/agents/session-history");
const { readableComputerTranscriptPath, readTranscriptChunks } = await import("@/lib/agents/session-transcript");
const { readComputerTranscript, deliverTranscriptAnswer } = await import("@/lib/computers/computer-workspace");
const { runInSession } = await import("@/lib/agents/session-runtime");

const SESSION = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e53";
const RUNNER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e51";
const OTHER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e52";
const WINDOWS_PATH = "C:\\Users\\me\\.claude\\projects\\C--work-repo\\6f1c.jsonl";

const user = (uuid: string, text: string) =>
    JSON.stringify({ type: "user", uuid, isSidechain: false, message: { role: "user", content: text } });
const reply = (uuid: string, text: string) =>
    JSON.stringify({ type: "assistant", uuid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text }] } });

/** A fake desktop holding `file`, answering like `transcript.ts` does. */
function fakeComputer(file: () => Buffer, chunkBytes = core.TRANSCRIPT_LIMITS.chunkBytes) {
    const asked: { path: string; query: { kind: string; offset: number } }[] = [];
    const readComputer = vi.fn(async (_session: { id: string; runnerId: string }, path: string, query: { kind: "chunk" | "line"; offset: number }) => {
        asked.push({ path, query });
        const bytes = file();
        if (query.kind === "line") {
            const newline = bytes.indexOf(0x0a, query.offset);
            return { kind: "line" as const, size: bytes.length, length: newline < 0 ? 0 : newline - query.offset + 1 };
        }
        return { kind: "chunk" as const, size: bytes.length, data: bytes.subarray(query.offset, query.offset + chunkBytes).toString("base64") };
    });
    return { readComputer, asked };
}

beforeEach(() => {
    db.messages = [];
    db.session = {
        id: SESSION,
        cli: "claude",
        state: "idle",
        place: "computer",
        runnerId: RUNNER,
        transcriptPath: WINDOWS_PATH,
        transcriptFile: null,
        transcriptOffset: null,
        transcriptSyncedAt: null
    };
    vi.mocked(runInSession).mockClear();
});

describe("readableComputerTranscriptPath", () => {
    it.each([
        WINDOWS_PATH,
        "C:/Users/me/.claude/projects/C--work-repo/6f1c.jsonl",
        "/Users/me/.claude/projects/-Users-me-work/6f1c.jsonl",
        "D:\\profiles\\me\\.claude-work\\projects\\x\\a.jsonl"
    ])("takes %s", (path) => {
        expect(readableComputerTranscriptPath(path)).toBe(true);
    });

    it.each([
        null,
        "",
        "relative\\.claude\\projects\\x\\a.jsonl",
        "C:\\Users\\me\\.claude\\projects\\a.jsonl",
        "C:\\Users\\me\\.claude\\projects\\..\\..\\x\\a.jsonl",
        "C:\\Users\\me\\.claude\\projects\\x\\a.txt",
        "C:\\Users\\me\\.codex\\sessions\\a.jsonl",
        "C:\\Users\\me\\.claude\\projects\\x\\a\n.jsonl"
    ])("refuses %j", (path) => {
        expect(readableComputerTranscriptPath(path)).toBe(false);
    });

    it("lets the hook store a Windows path at all", () => {
        expect(core.isTranscriptPath(WINDOWS_PATH)).toBe(true);
        expect(core.isTranscriptPath("C:\\Users\\..\\x.jsonl")).toBe(false);
        expect(core.isTranscriptPath("relative/x.jsonl")).toBe(false);
    });
});

describe("readTranscriptChunks", () => {
    it("joins chunks into whole lines and stops before a line still being written", async () => {
        const text = `${"a".repeat(7)}\n${"b".repeat(12)}\n{"partial`;
        const bytes = Buffer.from(text);
        const read = await readTranscriptChunks(
            0,
            async (query) => (query.kind === "chunk" ? { kind: "chunk", size: bytes.length, bytes: bytes.subarray(query.offset, query.offset + 5) } : null),
            { chunkBytes: 5, maxChunks: 20 }
        );
        expect(read).toMatchObject({ kind: "ok", next: 21, more: true, skipped: 0 });
        expect(read.kind === "ok" && read.lines.map((line) => line.text)).toEqual(["a".repeat(7), "b".repeat(12)]);
    });

    it("steps over a line too long to hold once it has ended", async () => {
        const bytes = Buffer.from(`${"x".repeat(40)}\nok\n`);
        const read = await readTranscriptChunks(
            0,
            async (query) => {
                if (query.kind === "chunk") return { kind: "chunk", size: bytes.length, bytes: bytes.subarray(query.offset, query.offset + 8) };
                return { kind: "line", size: bytes.length, length: bytes.indexOf(0x0a, query.offset) - query.offset + 1 };
            },
            { chunkBytes: 8, maxChunks: 20, maxLineBytes: 10 }
        );
        expect(read).toMatchObject({ kind: "ok", skipped: 1, next: bytes.length, more: false });
        expect(read.kind === "ok" && read.lines.map((line) => line.text)).toEqual(["ok"]);
    });
});

describe("computerTranscriptAnswer", () => {
    it("decodes a chunk and keeps the rest as they are", () => {
        expect(computerTranscriptAnswer({ kind: "chunk", size: 3, data: Buffer.from("hi\n").toString("base64") })).toEqual({ kind: "chunk", size: 3, bytes: Buffer.from("hi\n") });
        expect(computerTranscriptAnswer({ kind: "line", size: 9, length: 4 })).toEqual({ kind: "line", size: 9, length: 4 });
        expect(computerTranscriptAnswer({ kind: "missing" })).toEqual({ kind: "missing" });
        expect(computerTranscriptAnswer(null)).toBeNull();
    });
});

describe("syncSessionHistory on a computer", () => {
    it("reads the transcript from the desktop, stores each line once and keeps the cursor", async () => {
        const text = `${user("u-1", "fix the login bug")}\n${reply("a-1", "On it.")}\n`;
        const computer = fakeComputer(() => Buffer.from(text));
        expect(await syncSessionHistory(SESSION, { readComputer: computer.readComputer, now: new Date(Date.now()) })).toBe("synced");
        expect(db.messages.map((one) => [one.role, one.body])).toEqual([
            ["user", "fix the login bug"],
            ["agent", "On it."]
        ]);
        expect(db.session!.transcriptOffset).toBe(BigInt(Buffer.byteLength(text)));
        expect(db.session!.transcriptFile).toBe(WINDOWS_PATH);
        expect(computer.asked[0]).toEqual({ path: WINDOWS_PATH, query: { kind: "chunk", offset: 0 } });
        expect(runInSession).not.toHaveBeenCalled();

        // The agent goes on; the next read starts where this one stopped.
        const more = `${text}${reply("a-2", "Done.")}\n`;
        const next = fakeComputer(() => Buffer.from(more));
        expect(await syncSessionHistory(SESSION, { readComputer: next.readComputer, now: new Date(Date.now() + 5_000) })).toBe("synced");
        expect(next.asked[0]!.query).toEqual({ kind: "chunk", offset: Buffer.byteLength(text) });
        expect(db.messages.map((one) => one.body)).toEqual(["fix the login bug", "On it.", "Done."]);
    });

    it("reads a transcript larger than one chunk across several", async () => {
        const lines = Array.from({ length: 30 }, (_, index) => reply(`a-${index}`, `answer ${index} ${"z".repeat(4000)}`));
        const text = `${lines.join("\n")}\n`;
        expect(Buffer.byteLength(text)).toBeGreaterThan(core.TRANSCRIPT_LIMITS.chunkBytes);
        const computer = fakeComputer(() => Buffer.from(text));
        expect(await syncSessionHistory(SESSION, { readComputer: computer.readComputer, now: new Date() })).toBe("synced");
        expect(db.messages).toHaveLength(30);
        expect(computer.asked.filter((one) => one.query.kind === "chunk").length).toBeGreaterThan(1);
    });

    it("is unavailable when the computer does not answer, and skipped when the file is not there", async () => {
        expect(await syncSessionHistory(SESSION, { readComputer: async () => null, now: new Date() })).toBe("unavailable");
        db.session!.transcriptSyncedAt = null;
        expect(await syncSessionHistory(SESSION, { readComputer: async () => ({ kind: "missing" }), now: new Date() })).toBe("skipped");
        expect(db.session!.transcriptOffset).toBeNull();
    });

    it("never asks for a path outside Claude Code's projects folder", async () => {
        db.session!.transcriptPath = "C:\\Users\\me\\Documents\\notes.jsonl";
        const computer = fakeComputer(() => Buffer.from(""));
        expect(await syncSessionHistory(SESSION, { readComputer: computer.readComputer, now: new Date() })).toBe("skipped");
        expect(computer.asked).toHaveLength(0);
    });
});

describe("readComputerTranscript", () => {
    function fakeDeps(features: string[]) {
        const commands: { runnerId: string; command: Record<string, unknown> }[] = [];
        return {
            commands,
            deps: {
                features: async () => features,
                send: async (runnerId: string, command: unknown) => {
                    commands.push({ runnerId, command: command as Record<string, unknown> });
                    return true;
                },
                listen: () => undefined,
                timeoutMs: 50
            }
        };
    }

    it("asks nothing of a runner without transcript-read", async () => {
        const { deps, commands } = fakeDeps(["workspace-read"]);
        expect(await readComputerTranscript({ id: SESSION, runnerId: RUNNER }, WINDOWS_PATH, { kind: "chunk", offset: 0 }, deps)).toBeNull();
        expect(commands).toHaveLength(0);
    });

    it("sends transcript.read and takes the answer only from the runner asked", async () => {
        const { deps, commands } = fakeDeps(["transcript-read"]);
        const read = readComputerTranscript({ id: SESSION, runnerId: RUNNER }, WINDOWS_PATH, { kind: "chunk", offset: 7 }, deps);
        await vi.waitFor(() => expect(commands).toHaveLength(1));
        const command = commands[0]!.command;
        expect(command).toMatchObject({ type: "transcript.read", sessionId: SESSION, path: WINDOWS_PATH, query: { kind: "chunk", offset: 7 } });
        expect(core.serverMessageSchema.safeParse({ v: 1, ...command }).success).toBe(true);
        const publish = vi.fn(async () => undefined);
        const requestId = command.requestId as string;
        expect(deliverTranscriptAnswer(OTHER, requestId, { kind: "missing" }, publish)).toBe(false);
        expect(deliverTranscriptAnswer(RUNNER, requestId, { kind: "chunk", size: 9, data: "" }, publish)).toBe(true);
        expect(await read).toEqual({ kind: "chunk", size: 9, data: "" });
        expect(publish).not.toHaveBeenCalled();
    });

    it("hands an answer for a read held elsewhere to the other nodes", () => {
        const publish = vi.fn(async () => undefined);
        expect(deliverTranscriptAnswer(RUNNER, SESSION, { kind: "missing" }, publish)).toBe(false);
        expect(publish).toHaveBeenCalledWith({ k: "transcript", runnerId: RUNNER, requestId: SESSION, answer: { kind: "missing" } });
    });

    it("is gated by its own feature in the protocol", () => {
        expect(core.SERVER_FRAME_FEATURE["transcript.read"]).toBe("transcript-read");
        expect(core.RELAYED_SERVER_TYPES).toContain("transcript.read");
        expect(
            core.parseRunnerFrame(JSON.stringify({ v: 1, type: "transcript.answer", requestId: RUNNER, sessionId: SESSION, answer: { kind: "line", size: 1, length: 1 } })).ok
        ).toBe(true);
    });
});
