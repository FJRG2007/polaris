/**
 * The voice delegator of a Code call: the handoff a session is sent, the
 * spoken session search, the tools it acts with, the call's announcement of a
 * session's reply, and the helpers that pick what of a reply is read aloud.
 */

import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { PolarCodeRow, PolarCodeThread } from "@/lib/polar/code";
import { callTail, landedReply, replyLead } from "@/components/polar/code-voice-call";
import { callReducer, INITIAL_CALL, voiceDelegateBodySchema } from "@/lib/polar/voice-call";
import { voiceTools, sessionExcerpts, delegatorInstructions, type DelegateDeps } from "@/lib/polar/voice-delegate";
import {
    VOICE_HANDOFF_CONTINUED,
    VOICE_HANDOFF_HEADER,
    formatHandoff,
    parseVoiceDelegation,
    sessionMatch
} from "@/lib/polar/voice-handoff";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(id: string, title: string, repo = "acme/app", state: PolarCodeRow["state"] = "idle"): PolarCodeRow {
    return { id, title, repo, branch: "main", state, stateLabel: state, live: true, createdAt: "2026-11-16T10:00:00.000Z" };
}

function thread(
    session: PolarCodeRow,
    entries: Array<{ role: string; text: string; at?: string }>,
    extra: Partial<PolarCodeThread> = {}
): PolarCodeThread {
    return {
        session,
        entries: entries.map((entry, index) => ({
            at: entry.at ?? `2026-11-16T10:0${index}:00.000Z`,
            type: "message",
            role: entry.role,
            text: entry.text,
            detail: ""
        })),
        error: null,
        permission: null,
        ...extra
    } as unknown as PolarCodeThread;
}

function fakeDeps(threads: Record<string, PolarCodeThread>, rows: PolarCodeRow[]) {
    const calls: string[] = [];
    const prompts: Array<{ sessionId: string; text: string }> = [];
    const deps: DelegateDeps = {
        list: async () => rows,
        thread: async (id) => threads[id] ?? null,
        prompt: async (sessionId, text) => {
            calls.push(`prompt:${sessionId}`);
            prompts.push({ sessionId, text });
            return {};
        },
        interrupt: async (id) => {
            calls.push(`interrupt:${id}`);
            return {};
        },
        model: async (id, model) => {
            calls.push(`model:${id}:${model}`);
            return {};
        },
        sleep: async () => undefined
    };
    return { deps, calls, prompts };
}

async function run(tools: ToolSet, name: string, input: unknown): Promise<any> {
    const execute = tools[name]!.execute as (input: unknown, options: unknown) => Promise<unknown>;
    return execute(input, { toolCallId: "call", messages: [] });
}

function setup(threads: Record<string, PolarCodeThread>, rows: PolarCodeRow[]) {
    const fake = fakeDeps(threads, rows);
    const outcome = { open: null as string | null, sent: [] as Array<{ sessionId: string; at: string }>, explained: {} as Record<string, number> };
    const request = { viewed: A, instruction: "fix the login test", tail: ["assistant: Hi."], signal: new AbortController().signal };
    return { ...fake, outcome, request, tools: voiceTools(fake.deps, request, outcome) };
}

describe("voice handoff", () => {
    it("writes the header, then sorted JSON, and reads the instruction back", () => {
        const text = formatHandoff({ instruction: "Check the upload test.", transcript: ["user: um the upload test"], context: "Session Uploads", full: true });
        expect(text).toBe(`${VOICE_HANDOFF_HEADER}
{
  "context": "Session Uploads",
  "instruction": "Check the upload test.",
  "transcript_delta": [
    "user: um the upload test"
  ]
}`);
        expect(parseVoiceDelegation(text)).toBe("Check the upload test.");
    });

    it("drops an empty context and reads the continued header too", () => {
        const text = formatHandoff({ instruction: "Hi", transcript: [], context: " ", full: false });
        expect(text).toBe(`${VOICE_HANDOFF_CONTINUED}\n{\n  "instruction": "Hi",\n  "transcript_delta": []\n}`);
        expect(parseVoiceDelegation(text)).toBe("Hi");
    });

    it("leaves a typed message, or one that only looks like a delegation, alone", () => {
        expect(parseVoiceDelegation("fix it")).toBeNull();
        expect(parseVoiceDelegation(`${VOICE_HANDOFF_CONTINUED}\nnot json`)).toBeNull();
    });
});

describe("spoken session search", () => {
    it("matches the name exactly through filler words, in either language", () => {
        expect(sessionMatch("the hex session", { title: "Hex", repo: "" })).toBe(100);
        expect(sessionMatch("la sesión de facturas", { title: "Facturas", repo: "" })).toBe(100);
    });

    it("forgives word order and one misheard letter", () => {
        expect(sessionMatch("tests login", { title: "Login tests", repo: "acme/app" })).toBeGreaterThanOrEqual(50);
        expect(sessionMatch("payment", { title: "Paymant retries", repo: "" })).toBeGreaterThanOrEqual(50);
    });

    it("finds nothing for an unrelated name", () => {
        expect(sessionMatch("kubernetes", { title: "Login tests", repo: "acme/app" })).toBeUndefined();
    });
});

describe("voice delegator tools", () => {
    it("sends the full header once, then the short one, and records what it sent", async () => {
        const s = setup({ [A]: thread(row(A, "Login"), []) }, [row(A, "Login")]);
        expect(await run(s.tools, "send_message", { text: "Fix the login test" })).toEqual({ sent: A });
        expect(await run(s.tools, "send_message", { text: "Also run lint" })).toEqual({ sent: A });
        expect(s.prompts[0]!.text.startsWith(VOICE_HANDOFF_HEADER)).toBe(true);
        expect(s.prompts[1]!.text.startsWith(VOICE_HANDOFF_CONTINUED)).toBe(true);
        expect(parseVoiceDelegation(s.prompts[0]!.text)).toBe("Fix the login test");
        expect(s.prompts[0]!.text).toContain("user: fix the login test");
        expect(s.outcome.sent.map((sent) => sent.sessionId)).toEqual([A, A]);
        expect(Object.keys(s.outcome.explained)).toEqual([A]);
    });

    it("steers by stopping the turn before sending", async () => {
        const s = setup({ [A]: thread(row(A, "Login", "acme/app", "working"), []) }, []);
        await run(s.tools, "send_message", { text: "Stop that, do the docs", delivery: "steer" });
        expect(s.calls).toEqual([`interrupt:${A}`, `prompt:${A}`]);
    });

    it("says a refused send failed and records nothing", async () => {
        const s = setup({}, []);
        s.deps.prompt = async () => ({ error: "That session has ended." });
        expect(await run(s.tools, "send_message", { text: "Go" })).toEqual({ error: "That session has ended." });
        expect(s.outcome.sent).toEqual([]);
        expect(s.outcome.explained).toEqual({});
    });

    it("opens a session and aims the next tools at it", async () => {
        const s = setup({ [A]: thread(row(A, "Login"), []), [B]: thread(row(B, "Docs"), []) }, []);
        expect(await run(s.tools, "open_session", { session_id: B })).toEqual({ opened: "Docs" });
        expect(s.outcome.open).toBe(B);
        await run(s.tools, "interrupt_session", {});
        expect(s.calls).toEqual([`interrupt:${B}`]);
    });

    it("does not move the screen to a session that is not there", async () => {
        const s = setup({}, []);
        expect(await run(s.tools, "open_session", { session_id: B })).toHaveProperty("error");
        expect(s.outcome.open).toBeNull();
    });

    it("switches the model, takes default as the account's own, and refuses a strange name", async () => {
        const s = setup({}, []);
        expect(await run(s.tools, "switch_model", { model: "opus" })).toEqual({ switched: "opus" });
        expect(await run(s.tools, "switch_model", { model: "Default" })).toEqual({ switched: "default" });
        expect(await run(s.tools, "switch_model", { model: "opus; rm -rf /" })).toHaveProperty("error");
        expect(s.calls).toEqual([`model:${A}:opus`, `model:${A}:null`]);
    });

    it("searches best match first and marks the session on screen", async () => {
        const rows = [row(B, "Docs refresh"), row(A, "Login tests")];
        const s = setup({}, rows);
        const found = await run(s.tools, "search_sessions", { query: "the login session" });
        expect(found).toEqual([expect.objectContaining({ id: A, on_screen: true })]);
    });

    it("reads text only, cut short, with the voice envelope taken off", async () => {
        const long = "x".repeat(900);
        const spoken = formatHandoff({ instruction: "Fix it", transcript: [], full: true });
        const t = thread(row(A, "Login"), [
            { role: "user", text: spoken },
            { role: "assistant", text: long }
        ]);
        expect(sessionExcerpts(t)).toEqual([
            { role: "user", text: "Fix it" },
            { role: "assistant", text: "x".repeat(400) }
        ]);
    });

    it("waits until the turn ends, then reads", async () => {
        const working = thread(row(A, "Login", "acme/app", "working"), []);
        const done = thread(row(A, "Login"), [{ role: "assistant", text: "All green." }]);
        const s = setup({}, []);
        let reads = 0;
        s.deps.thread = async () => (++reads < 3 ? working : done);
        const answer = await run(s.tools, "wait_for_session", {});
        expect(answer.messages).toEqual([{ role: "assistant", text: "All green." }]);
        expect(reads).toBe(4);
    });

    it("turns a failing dependency into an answer that says so", async () => {
        const s = setup({}, []);
        s.deps.list = async () => {
            throw new Error("database down");
        };
        expect(await run(s.tools, "list_sessions", {})).toEqual({
            error: "Tool request failed. Do not claim it succeeded."
        });
    });

    it("names the viewed session and the language in its instructions", () => {
        const text = delegatorInstructions({ id: A, title: "Login" }, ["user: hi"], "es-ES");
        expect(text).toContain(`"id":"${A}"`);
        expect(text).toContain('"es-ES"');
        expect(text).toContain("user: hi");
    });
});

describe("a Code call's turn body", () => {
    it("takes a turn and refuses one with no session or too much", () => {
        expect(voiceDelegateBodySchema.safeParse({ text: "hi", sessionId: A }).success).toBe(true);
        expect(voiceDelegateBodySchema.safeParse({ text: "hi" }).success).toBe(false);
        expect(voiceDelegateBodySchema.safeParse({ text: "x".repeat(2_001), sessionId: A }).success).toBe(false);
        expect(
            voiceDelegateBodySchema.safeParse({ text: "hi", sessionId: A, tail: Array(13).fill("a") }).success
        ).toBe(false);
        expect(voiceDelegateBodySchema.safeParse({ text: "hi", sessionId: A, extra: 1 }).success).toBe(false);
    });
});

describe("announcing a session's reply", () => {
    it("speaks into a quiet call only", () => {
        expect(callReducer(INITIAL_CALL, { type: "announce" }).phase).toBe("thinking");
        const hearing = callReducer(INITIAL_CALL, { type: "speech-start" });
        expect(callReducer(hearing, { type: "announce" })).toBe(hearing);
        const muted = callReducer(INITIAL_CALL, { type: "mute" });
        expect(callReducer(muted, { type: "announce" })).toBe(muted);
    });

    it("can be talked over like any answer", () => {
        const announcing = callReducer(INITIAL_CALL, { type: "announce" });
        const over = callReducer(announcing, { type: "speech-start" });
        expect(over.phase).toBe("hearing");
        expect(over.interruptions).toBe(1);
    });

    it("waits for the turn to end and takes the reply written after the message", () => {
        const since = "2026-11-16T10:00:30.000Z";
        const entries = [
            { role: "assistant", text: "Old answer", at: "2026-11-16T10:00:00.000Z" },
            { role: "assistant", text: "Fixed the test.\n\nDetails follow.", at: "2026-11-16T10:01:00.000Z" }
        ];
        expect(landedReply(thread(row(A, "L", "", "working"), entries), since)).toBeNull();
        expect(landedReply(thread(row(A, "L"), entries), since)?.text).toBe("Fixed the test.\n\nDetails follow.");
        expect(landedReply(thread(row(A, "L"), entries.slice(0, 1)), since)).toBeNull();
    });

    it("reads the lead paragraph, and sends the call's last lines, cut short", () => {
        expect(replyLead("Fixed the test.\n\nDetails follow.")).toBe("Fixed the test.");
        const lines = Array.from({ length: 15 }, (_, i) => ({
            id: String(i),
            role: "user" as const,
            parts: [{ type: "text" as const, text: i === 14 ? "y".repeat(500) : `line ${i}` }]
        }));
        const tail = callTail(lines);
        expect(tail).toHaveLength(12);
        expect(tail[0]).toBe("user: line 3");
        expect(tail.at(-1)).toHaveLength(400);
    });
});

vi.mock("@/components/polar/polar-voice", () => ({ VoiceCall: () => null }));
