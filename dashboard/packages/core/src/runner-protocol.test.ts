import { describe, expect, it } from "vitest";
import {
    RELAYED_SERVER_TYPES,
    RUNNER_LIMITS,
    RUNNER_PROTOCOL_VERSION,
    SERVER_FRAME_FEATURE,
    encodeServerFrame,
    parseRunnerFrame,
    parseServerFrame,
    protocolCompatible,
    runnerHasFeature
} from "./runner-protocol.js";

const SESSION = "0190a5f2-1111-7000-8000-000000000001";

describe("runner frames", () => {
    it("reads a hello and capabilities", () => {
        const hello = parseRunnerFrame(
            JSON.stringify({ v: 1, type: "hello", runnerVersion: "0.1.0", protocol: { min: 1, max: 1 } })
        );
        expect(hello.ok).toBe(true);
        const caps = parseRunnerFrame(
            JSON.stringify({
                v: 1,
                type: "capabilities",
                os: { platform: "win32", release: "10.0.26200", arch: "x64" },
                hostname: "desk",
                shells: [{ id: "pwsh", path: "C:/Program Files/PowerShell/7/pwsh.exe" }],
                clis: [{ id: "claude", version: "2.0.0", signedIn: "yes" }],
                maxSessions: 4
            })
        );
        expect(caps.ok).toBe(true);
    });

    it("refuses an unknown type, a bad id and a non-JSON frame", () => {
        expect(parseRunnerFrame(JSON.stringify({ v: 1, type: "shell", cmd: "rm -rf /" })).ok).toBe(false);
        expect(parseRunnerFrame(JSON.stringify({ v: 1, type: "session.started", sessionId: "x", workdir: "/" })).ok).toBe(false);
        const notJson = parseRunnerFrame("{");
        expect(notJson.ok === false && notJson.code).toBe("not_json");
    });

    it("refuses a frame over the size limit before parsing it", () => {
        const huge = parseRunnerFrame("x".repeat(RUNNER_LIMITS.frameBytes + 1));
        expect(huge.ok === false && huge.code).toBe("too_large");
    });

    it("bounds a terminal chunk and keeps it base64", () => {
        const ok = parseRunnerFrame(JSON.stringify({ v: 1, type: "terminal.output", sessionId: SESSION, seq: 0, data: "aGk=" }));
        expect(ok.ok).toBe(true);
        const bad = parseRunnerFrame(JSON.stringify({ v: 1, type: "terminal.output", sessionId: SESSION, seq: 0, data: "<script>" }));
        expect(bad.ok).toBe(false);
        const big = "A".repeat(Math.ceil(RUNNER_LIMITS.terminalChunkBytes / 3) * 4 + 4);
        expect(parseRunnerFrame(JSON.stringify({ v: 1, type: "terminal.output", sessionId: SESSION, seq: 1, data: big })).ok).toBe(false);
    });

    it("takes hook events in the normalised vocabulary only", () => {
        expect(parseRunnerFrame(JSON.stringify({ v: 1, type: "event", sessionId: SESSION, kind: "turn.end", detail: "" })).ok).toBe(true);
        expect(parseRunnerFrame(JSON.stringify({ v: 1, type: "event", sessionId: SESSION, kind: "Stop", detail: "" })).ok).toBe(false);
    });
});

describe("server frames", () => {
    it("encodes with the envelope and round-trips", () => {
        const raw = encodeServerFrame({ type: "prompt", sessionId: SESSION, text: "fix the build" });
        const parsed = parseServerFrame(raw);
        expect(parsed.ok && parsed.message.v).toBe(RUNNER_PROTOCOL_VERSION);
    });

    it("refuses to encode a prompt over the limit or an http clone", () => {
        expect(() => encodeServerFrame({ type: "prompt", sessionId: SESSION, text: "x".repeat(RUNNER_LIMITS.promptChars + 1) })).toThrow();
        expect(() =>
            encodeServerFrame({
                type: "session.start",
                sessionId: SESSION,
                cli: "claude",
                command: null,
                model: null,
                effort: null,
                permissionMode: null,
                repository: { kind: "clone", url: "http://example.test/a.git", fullName: "a/b" },
                branch: "polar/x",
                baseRef: "",
                worktree: true,
                prompt: null,
                report: { url: "https://polaris.example.test/api/agents/sessions/x/events", token: "t" },
                cols: 120,
                rows: 40
            })
        ).toThrow();
    });

    it("negotiates the version by range", () => {
        expect(protocolCompatible({ min: 1, max: 3 })).toBe(true);
        expect(protocolCompatible({ min: RUNNER_PROTOCOL_VERSION + 1, max: RUNNER_PROTOCOL_VERSION + 2 })).toBe(false);
    });
});

describe("optional features (additive on protocol 1)", () => {
    const caps = {
        v: 1,
        type: "capabilities",
        os: { platform: "darwin", release: "24.0.0", arch: "arm64" },
        hostname: "mac",
        shells: [],
        clis: [],
        maxSessions: 2
    };

    it("reads an older runner's capabilities as having no features", () => {
        const parsed = parseRunnerFrame(JSON.stringify(caps));
        expect(parsed.ok).toBe(true);
        if (parsed.ok && parsed.message.type === "capabilities") {
            expect(runnerHasFeature(parsed.message, "toolchain")).toBe(false);
            expect(runnerHasFeature(parsed.message, "claude-chat")).toBe(false);
        }
        expect(runnerHasFeature(null, "toolchain")).toBe(false);
    });

    it("reads announced features and the installed toolchain, keeping names it does not know", () => {
        const parsed = parseRunnerFrame(
            JSON.stringify({ ...caps, features: ["toolchain", "claude-chat", "later-thing"], toolchain: [{ tool: "git", version: "2.56.0-2" }] })
        );
        expect(parsed.ok).toBe(true);
        if (parsed.ok && parsed.message.type === "capabilities") {
            expect(runnerHasFeature(parsed.message, "claude-chat")).toBe(true);
            expect(parsed.message.features).toContain("later-thing");
        }
    });

    it("reads toolchain progress with a failure word and refuses prose in its place", () => {
        const base = { v: 1, type: "toolchain.progress", requestId: SESSION, tool: "node", step: "failed" };
        expect(parseRunnerFrame(JSON.stringify({ ...base, code: "checksum" })).ok).toBe(true);
        expect(parseRunnerFrame(JSON.stringify({ ...base, code: "The download broke" })).ok).toBe(false);
    });

    it("reads chat events and refuses an unknown kind", () => {
        const frame = (event: unknown) => JSON.stringify({ v: 1, type: "chat.event", turnId: SESSION, seq: 0, event });
        expect(parseRunnerFrame(frame({ kind: "text", text: "Hi" })).ok).toBe(true);
        expect(parseRunnerFrame(frame({ kind: "tool-call", callId: "t1", name: "tasks_list", input: {} })).ok).toBe(true);
        expect(parseRunnerFrame(frame({ kind: "approval", approvalId: SESSION, callId: "t1", name: "x", input: {} })).ok).toBe(true);
        expect(parseRunnerFrame(frame({ kind: "finish", reason: "stop", usage: { input: 1, output: 2 } })).ok).toBe(true);
        expect(parseRunnerFrame(frame({ kind: "shell", text: "rm" })).ok).toBe(false);
    });

    it("builds a chat turn, and marks which frames need a feature", () => {
        const raw = encodeServerFrame({
            type: "chat.turn",
            turnId: SESSION,
            model: null,
            system: "You are Polar.",
            messages: [{ role: "user", text: "Hello" }],
            effort: null,
            mcp: { url: "https://polaris.example.test/api/mcp", token: "fixture" }
        });
        expect(parseServerFrame(raw).ok).toBe(true);
        expect(() => encodeServerFrame({ type: "chat.turn", turnId: SESSION, model: null, system: "", messages: [], effort: null, mcp: null })).toThrow();
        expect(SERVER_FRAME_FEATURE["chat.turn"]).toBe("claude-chat");
        expect(SERVER_FRAME_FEATURE["toolchain.prepare"]).toBe("toolchain");
        expect(SERVER_FRAME_FEATURE["session.start"]).toBeUndefined();
        expect(RELAYED_SERVER_TYPES).toEqual(expect.arrayContaining(["chat.turn", "chat.cancel", "chat.approval", "toolchain.prepare"]));
    });
});
