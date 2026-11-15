import { describe, expect, it } from "vitest";
import {
    RUNNER_LIMITS,
    RUNNER_PROTOCOL_VERSION,
    encodeServerFrame,
    parseRunnerFrame,
    parseServerFrame,
    protocolCompatible
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
