import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as launch from "@/main/runner/launch";
import type { RunnerFrame } from "@/main/runner/connection";
import { SessionHost, type Terminal } from "@/main/runner/sessions";

const SESSION_ID = "4a1f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c";
const ROOT = join("/fixture", "runner");

const start: launch.SessionStart = {
    v: 1,
    type: "session.start",
    sessionId: SESSION_ID,
    cli: "claude",
    command: null,
    model: "sonnet",
    effort: null,
    permissionMode: "edits",
    repository: { kind: "clone", url: "https://github.com/octo/repo.git", fullName: "octo/repo" },
    branch: "polar/fix-1",
    baseRef: "main",
    worktree: true,
    prompt: null,
    report: { url: "https://polaris.example.test/api/agents/sessions/x/events", token: "fixture-token" },
    cols: 120,
    rows: 40
};

class FakeTerminal implements Terminal {
    written: string[] = [];
    data: ((data: string) => void) | null = null;
    exit: ((exit: { exitCode: number; }) => void) | null = null;
    size: [number, number] | null = null;
    killed = false;
    onData(listener: (data: string) => void): void {
        this.data = listener;
    }
    onExit(listener: (exit: { exitCode: number; }) => void): void {
        this.exit = listener;
    }
    write(data: string): void {
        this.written.push(data);
    }
    resize(cols: number, rows: number): void {
        this.size = [cols, rows];
    }
    kill(): void {
        this.killed = true;
    }
}

function harness(prepared: { ok: true; env: Record<string, string>; } | { ok: false; tool: string; code: string; } = { ok: true, env: { PATH: "/tc/bin" } }) {
    const sent: RunnerFrame[] = [];
    const gitCalls: { args: string[]; cwd: string; }[] = [];
    const spawned: { file: string; args: string[]; cwd: string; env: Record<string, string>; }[] = [];
    const timers: (() => void)[] = [];
    const terminal = new FakeTerminal();
    const files = new Map<string, string>();
    const host = new SessionHost({
        root: ROOT,
        platform: "linux",
        allowedFolders: () => [],
        send: (frame) => {
            sent.push(frame);
            return true;
        },
        spawnTerminal: (file, args, options) => {
            spawned.push({ file, args, cwd: options.cwd, env: options.env });
            return terminal;
        },
        prepare: async (_agents, onProgress) => {
            onProgress({ tool: "git", step: "download", received: 1, total: 2 });
            if (!prepared.ok) onProgress({ tool: prepared.tool, step: "failed", code: prepared.code as "offline" });
            return prepared;
        },
        git: async (args, options) => {
            gitCalls.push({ args, cwd: options.cwd });
            return 0;
        },
        exists: (file) => file === "/tc/bin/claude",
        mkdir: async () => undefined,
        writeFile: async (file, text) => void files.set(file, text),
        maxSessions: 2,
        setTimer: (run) => timers.push(run)
    });
    return { host, sent, gitCalls, spawned, timers, terminal, files };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runner sessions", () => {
    it("prepares, checks out a worktree, and starts Claude Code in a terminal with an argument list", async () => {
        const { host, sent, gitCalls, spawned, files } = harness();
        host.handle(start);
        await settle();
        expect(sent[0]).toMatchObject({ type: "toolchain.progress", sessionId: SESSION_ID, tool: "git", step: "download" });
        expect(gitCalls.map((call) => call.args)).toEqual([
            ["clone", "--no-checkout", "--", "https://github.com/octo/repo.git", join(ROOT, "repos", "octo__repo")],
            ["worktree", "prune"],
            ["worktree", "add", "-B", "polar/fix-1", join(ROOT, "sessions", SESSION_ID), "origin/main"]
        ]);
        expect(spawned[0]!.file).toBe("/tc/bin/claude");
        expect(spawned[0]!.args).toEqual(["--permission-mode", "acceptEdits", "--settings", `${ROOT}/state/${SESSION_ID}/claude-settings.json`]);
        expect(spawned[0]!.cwd).toBe(join(ROOT, "sessions", SESSION_ID));
        expect(spawned[0]!.env).toMatchObject({ POLARIS_REPORT_TOKEN: "fixture-token", TERM: "xterm-256color" });
        expect(JSON.parse(files.get(`${ROOT}/state/${SESSION_ID}/claude-settings.json`)!).hooks.Stop).toBeTruthy();
        expect(sent.at(-1)).toEqual({ type: "session.started", sessionId: SESSION_ID, workdir: join(ROOT, "sessions", SESSION_ID), branch: "polar/fix-1" });
        expect(host.ids()).toEqual([SESSION_ID]);
        expect(host.checkout(SESSION_ID)).toEqual({ workdir: join(ROOT, "sessions", SESSION_ID), env: { PATH: "/tc/bin" } });
        expect(host.checkout("0b7c5d1e-0000-4000-8000-000000000000")).toBeNull();
        host.stop(SESSION_ID, "stopped");
        expect(host.checkout(SESSION_ID)).toBeNull();
    });

    it("queues a prompt until the agent has drawn, then types it as a paste", async () => {
        const { host, terminal, timers } = harness();
        host.handle(start);
        await settle();
        host.handle({ v: 1, type: "prompt", sessionId: SESSION_ID, text: "fix it" });
        expect(terminal.written).toEqual([]);
        terminal.data!("welcome");
        for (const run of timers.splice(0)) run();
        expect(terminal.written).toEqual(["\u001b[200~fix it\u001b[201~\r"]);
    });

    it("relays output in order, replays it on attach, and passes input, resize and interrupt", async () => {
        const { host, sent, terminal, timers } = harness();
        host.handle(start);
        await settle();
        terminal.data!("hello ");
        terminal.data!("world");
        for (const run of timers.splice(0)) run();
        const outputs = sent.filter((frame) => frame.type === "terminal.output");
        expect(outputs).toHaveLength(1);
        expect(Buffer.from((outputs[0] as { data: string; }).data, "base64").toString()).toBe("hello world");
        host.handle({ v: 1, type: "terminal.attach", sessionId: SESSION_ID, cols: 90, rows: 30 });
        expect(terminal.size).toEqual([90, 30]);
        expect(sent.filter((frame) => frame.type === "terminal.output").map((frame) => (frame as { seq: number; }).seq)).toEqual([0, 1]);
        host.handle({ v: 1, type: "terminal.input", sessionId: SESSION_ID, data: Buffer.from("y").toString("base64") });
        host.handle({ v: 1, type: "interrupt", sessionId: SESSION_ID });
        expect(terminal.written.slice(-2)).toEqual(["y", "\u001b"]);
    });

    it("ends with failed after the progress frame carried the failure", async () => {
        const { host, sent, spawned } = harness({ ok: false, tool: "node", code: "offline" });
        host.handle(start);
        await settle();
        const failedAt = sent.findIndex((frame) => frame.type === "toolchain.progress" && frame.step === "failed");
        const endedAt = sent.findIndex((frame) => frame.type === "session.ended");
        expect(failedAt).toBeGreaterThanOrEqual(0);
        expect(endedAt).toBeGreaterThan(failedAt);
        expect(sent[endedAt]).toMatchObject({ reason: "failed" });
        expect(spawned).toHaveLength(0);
    });

    it("reports the exit and a stop", async () => {
        const { host, sent, terminal } = harness();
        host.handle(start);
        await settle();
        terminal.exit!({ exitCode: 3 });
        expect(sent.at(-1)).toEqual({ type: "session.ended", sessionId: SESSION_ID, reason: "exited", exitCode: 3 });
        expect(host.ids()).toEqual([]);
        host.handle({ ...start, sessionId: "5b2f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c" });
        await settle();
        host.handle({ v: 1, type: "session.stop", sessionId: "5b2f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c" });
        expect(sent.at(-1)).toMatchObject({ type: "session.ended", reason: "stopped" });
        expect(terminal.killed).toBe(true);
    });

    it("refuses an unsafe branch and a folder the person did not pick", async () => {
        const { host, sent, gitCalls } = harness();
        host.handle({ ...start, branch: "--upload-pack=evil" });
        await settle();
        expect(sent.at(-1)).toMatchObject({ type: "session.ended", reason: "failed" });
        expect(gitCalls).toHaveLength(0);
        host.handle({ ...start, sessionId: "6c3f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c", repository: { kind: "path", path: "/etc" } });
        await settle();
        expect(sent.at(-1)).toMatchObject({ type: "session.ended", reason: "failed" });
    });
});

describe("runner launch helpers", () => {
    it("splits a custom command without a shell", () => {
        expect(launch.splitCommand(`aider --model "gpt 5" 'a b' c\\d`)).toEqual(["aider", "--model", "gpt 5", "a b", "c\\d"]);
        expect(launch.splitCommand(`x "unterminated`)).toBeNull();
        expect(launch.splitCommand(`a "" b`)).toEqual(["a", "", "b"]);
    });

    it("finds an npm shim by PATHEXT on Windows", () => {
        const found = launch.findOnPath("claude", { Path: "C:\\tc\\npm", PATHEXT: ".EXE;.CMD" }, "win32", (file) => file === "C:\\tc\\npm\\claude.cmd");
        expect(found).toBe("C:\\tc\\npm\\claude.cmd");
    });

    it("keeps the hook program free of anything a shell would expand", () => {
        expect(launch.HOOK_RELAY_PROGRAM).not.toMatch(/[$`"\\]/);
        const settings = launch.claudeRunnerSettings() as { hooks: Record<string, { hooks: { command: string; timeout: number; }[]; }[]>; };
        expect(settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBe(130);
        expect(settings.hooks.Stop![0]!.hooks[0]!.command.startsWith("node -e ")).toBe(true);
    });

    it("checks refs", () => {
        for (const ok of ["main", "polar/fix-1", "release-1.2"]) expect(launch.safeRef(ok)).toBe(true);
        for (const bad of ["-x", "a..b", "a.lock", "", "a b", "/a"]) expect(launch.safeRef(bad)).toBe(false);
    });
});
