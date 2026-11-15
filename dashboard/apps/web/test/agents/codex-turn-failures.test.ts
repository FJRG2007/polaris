/**
 * A Codex turn that ended without a hook: the rollout's newest boundary is
 * read (through the exec cap, from the end of the file), and a failure or an
 * Esc newer than what put the session in its turn ends it once, a usage limit
 * reaching the rotation.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

const db = vi.hoisted(() => ({
    session: null as Record<string, unknown> | null,
    events: [] as { kind: string; detail: string; seq: bigint | null }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: async () => (db.session ? { ...db.session } : null),
            findMany: async () => (db.session ? [{ ...db.session }] : [])
        }
    }
}));
vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: async () => ({ code: 0, output: "" }) }));
vi.mock("@/lib/agents/session-service", () => ({
    recordSessionEvents: async (_id: string, events: { kind: string; detail: string }[], seq: bigint | null) => {
        for (const event of events) db.events.push({ kind: event.kind, detail: event.detail, seq });
        if (db.session) db.session.lastEventSeq = seq;
        return "idle";
    }
}));
vi.mock("@/lib/agents/account-rotation", () => ({ handleTurnFailure: async () => "rotated" }));
vi.mock("@/lib/agents/signin-refusal", () => ({ isSignInRefusal: () => false, noteRefusedSignIn: async () => undefined }));

const { newestCodexBoundary } = await import("@/lib/agents/transcript-decoders");
const failures = await import("@/lib/agents/codex-turn-failures");
const { readTranscriptTail, TRANSCRIPT_CHUNK_BYTES } = await import("@/lib/agents/session-transcript");

const AT = "2026-11-15T10:00:05.123Z";
const LIMIT = "You've hit your usage limit. Try again at 3:05 PM.";

function event(payload: Record<string, unknown>, timestamp = AT): string {
    return JSON.stringify({ timestamp, type: "event_msg", payload });
}
const started = event({ type: "task_started" }, "2026-11-15T10:00:00.000Z");
const failed = event({ type: "task_complete", last_agent_message: null, error: { message: LIMIT } });
const message = JSON.stringify({ timestamp: AT, type: "response_item", payload: { type: "message", role: "assistant", content: [] } });

describe("newestCodexBoundary", () => {
    it("reads a failed turn end, its time and its words", () => {
        expect(newestCodexBoundary([started, message, failed, message])).toEqual({
            kind: "ended",
            at: Date.parse(AT),
            error: LIMIT,
            interrupted: false
        });
    });

    it("treats a later turn start as the failure being history, and no boundary as nothing", () => {
        expect(newestCodexBoundary([failed, started])).toEqual({ kind: "started" });
        expect(newestCodexBoundary([message, "not json", '{"type":"event_msg"'])).toBeNull();
    });

    it("tells an Esc from a turn replaced, and a clean end from a failed one", () => {
        expect(newestCodexBoundary([event({ type: "turn_aborted", reason: "interrupted" })])).toMatchObject({ interrupted: true, error: null });
        expect(newestCodexBoundary([event({ type: "turn_aborted", reason: "replaced" })])).toMatchObject({ interrupted: false, error: null });
        expect(newestCodexBoundary([event({ type: "task_complete", error: null })])).toMatchObject({ kind: "ended", error: null });
        expect(newestCodexBoundary([event({ type: "task_complete", error: { message: LIMIT } }, "yesterday")])).toMatchObject({ at: null });
    });
});

describe("noteCodexTurnEnd", () => {
    const seen: { message: string; seq: bigint }[] = [];
    const ports = {
        failed: async (_id: string, text: string, seq: bigint) => {
            seen.push({ message: text, seq });
        }
    };
    beforeEach(() => {
        seen.length = 0;
        db.events = [];
        db.session = {
            id: "s1",
            cli: "codex",
            state: "working",
            lastEventSeq: BigInt(Date.parse("2026-11-15T10:00:00.000Z")) * 1_000_000n,
            transcriptPath: "/home/node/.polaris-accounts/codex/acc-1/sessions/2026/11/15/rollout-2026-11-15T10-00-00-abc.jsonl"
        };
    });

    it("ends the turn as failed once and hands the limit to the rotation with the record's own sequence", async () => {
        const boundary = newestCodexBoundary([started, failed]);
        expect(await failures.noteCodexTurnEnd("s1", boundary, ports)).toBe("failed");
        const seq = BigInt(Date.parse(AT)) * 1_000_000n;
        expect(db.events).toEqual([{ kind: "turn.failed", detail: LIMIT, seq }]);
        expect(seen).toEqual([{ message: LIMIT, seq }]);
        // Read again by the next sweep: older than nothing new, acted on once.
        db.session!.state = "working";
        expect(await failures.noteCodexTurnEnd("s1", boundary, ports)).toBeNull();
        expect(seen).toHaveLength(1);
    });

    it("ends an Esc as a finished turn, and leaves an idle session, another tool and an older end alone", async () => {
        const esc = newestCodexBoundary([event({ type: "turn_aborted", reason: "interrupted" })]);
        expect(await failures.noteCodexTurnEnd("s1", esc, ports)).toBe("interrupted");
        expect(db.events.map((one) => one.kind)).toEqual(["turn.end"]);
        const boundary = newestCodexBoundary([failed]);
        db.session!.lastEventSeq = 0n;
        db.session!.state = "idle";
        expect(await failures.noteCodexTurnEnd("s1", boundary, ports)).toBeNull();
        db.session!.state = "working";
        db.session!.cli = "claude";
        expect(await failures.noteCodexTurnEnd("s1", boundary, ports)).toBeNull();
        db.session!.cli = "codex";
        db.session!.lastEventSeq = BigInt(Date.parse(AT) + 1) * 1_000_000n;
        expect(await failures.noteCodexTurnEnd("s1", boundary, ports)).toBeNull();
        expect(seen).toEqual([]);
    });

    it("reads only a Codex rollout, including one named through an account home", () => {
        expect(failures.isCodexRollout(db.session!.transcriptPath as string)).toBe(true);
        expect(failures.isCodexRollout("/home/node/.codex/sessions/2026/11/15/rollout-x.jsonl")).toBe(true);
        expect(failures.isCodexRollout("/home/node/.codex/sessions/2026/11/15/other.jsonl")).toBe(false);
        expect(failures.isCodexRollout("/etc/passwd")).toBe(false);
    });

    it("sweeps a quiet session through its exec path and ends the failed turn", async () => {
        const tail = `${started}\n${failed}\n`;
        const answer = `polaris-transcript: chunk ${Buffer.byteLength(tail)}\n${Buffer.from(tail).toString("base64")}\n`;
        const scripts: string[] = [];
        const ended = await failures.sweepCodexTurnEnds({
            run: async (_id, script) => {
                scripts.push(script);
                return { code: 0, output: answer };
            },
            ports
        });
        expect(ended).toBe(1);
        expect(scripts).toHaveLength(1);
        expect(seen.map((one) => one.message)).toEqual([LIMIT]);
    });
});

function hasSh(): boolean {
    try {
        execFileSync("sh", ["-c", "command -v base64 && command -v tail && command -v head"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/** A path sh can open on this machine: Git Bash takes `/c/...` for `C:\...`. */
function shPath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`);
}

describe.runIf(hasSh())("readTranscriptTail on a real shell", () => {
    const EXEC_CAP = 16 * 1024;
    async function run(script: string): Promise<string> {
        const output = execFileSync("sh", ["-c", script], { encoding: "utf8" });
        expect(Buffer.byteLength(output)).toBeLessThan(EXEC_CAP);
        return output;
    }

    it("walks back past a large record to the turn end, under the exec cap, leaving the line being written", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "polaris-codex-")), ".codex", "sessions", "2026", "11", "15");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "rollout-2026-11-15T10-00-00-abc.jsonl");
        const big = JSON.stringify({ timestamp: AT, type: "response_item", payload: { output: "x".repeat(TRANSCRIPT_CHUNK_BYTES * 2) } });
        writeFileSync(path, `${started}\n${failed}\n${big}\n${message}\n{"timestamp":"${AT}","type":"event`);
        const read = await readTranscriptTail(shPath(path), run, (lines) => newestCodexBoundary(lines) !== null);
        expect(read.kind).toBe("ok");
        if (read.kind !== "ok") return;
        expect(read.lines.at(-1)).toBe(message);
        expect(newestCodexBoundary(read.lines)).toMatchObject({ error: LIMIT });
    });

    it("says missing for a rollout that is not there", async () => {
        const read = await readTranscriptTail("/nonexistent/.codex/sessions/rollout-x.jsonl", run, () => true);
        expect(read.kind).toBe("missing");
    });
});
