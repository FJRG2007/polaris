/**
 * A Terminal session answered in Chat from Polar Code: where a message goes,
 * and the script that gives the conversation back to the terminal on a key -
 * run for real against a stand-in tmux, so the order (Chat's agent stopped
 * before the terminal resumes, on the conversation Chat last had) is what a
 * shell does rather than what the source says.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from "node:fs";
import {
    ACP_TERMINAL_BACK,
    acpLaunchCommand,
    AGENT_LOCK_DIR,
    agentLockCommand,
    TERMINAL_BACK_FILE
} from "@/lib/agents/acp/pipe-commands";
import {
    CHAT_CONVERSATION_FILE,
    chatConversationCommand,
    chatEntryCommand,
    chatHoldCommand,
    chatHoldStopCommand,
    handsOff,
    remoteTurnRoute,
    TERMINAL_BACK,
    TERMINAL_BACK_EVENT,
    terminalBackCommand
} from "@/lib/agents/acp/handoff";

const IDLE_CLAUDE = {
    cli: "claude",
    place: "local" as const,
    surface: "terminal" as const,
    state: "idle" as const,
    vendorSessionId: "0f1e2d3c-4b5a-4968-8776-655443322110",
    chatFailedRecently: false
};

describe("remoteTurnRoute", () => {
    it("hands an idle Terminal session with a conversation to Chat", () => {
        expect(remoteTurnRoute(IDLE_CLAUDE)).toBe("hand-off");
        expect(remoteTurnRoute({ ...IDLE_CLAUDE, cli: "codex" })).toBe("hand-off");
    });

    it("keeps a session already in Chat there", () => {
        expect(remoteTurnRoute({ ...IDLE_CLAUDE, surface: "chat", state: "working" })).toBe("chat");
    });

    it("never stops a terminal mid-turn or holding a question", () => {
        for (const state of ["working", "waiting", "starting", "queued"] as const)
            expect(remoteTurnRoute({ ...IDLE_CLAUDE, state })).toBe("terminal");
    });

    it("leaves the terminal alone without a conversation Chat could reopen", () => {
        expect(remoteTurnRoute({ ...IDLE_CLAUDE, vendorSessionId: null })).toBe("terminal");
        expect(remoteTurnRoute({ ...IDLE_CLAUDE, vendorSessionId: "not one; rm -rf" })).toBe("terminal");
    });

    it("stays in the terminal while Chat failed to start here lately", () => {
        expect(remoteTurnRoute({ ...IDLE_CLAUDE, chatFailedRecently: true })).toBe("terminal");
    });

    it("hands off only agents whose terminal and Chat share the conversation id, never on a computer", () => {
        expect(handsOff("claude", "host")).toBe(true);
        expect(handsOff("claude", "computer")).toBe(false);
        expect(handsOff("gemini", "local")).toBe(false);
        expect(remoteTurnRoute({ ...IDLE_CLAUDE, cli: "gemini" })).toBe("terminal");
    });
});

describe("the terminal's waiting script", () => {
    it("refuses an id it could not type", () => {
        expect(() => chatHoldCommand("/state", "x y")).toThrow();
        expect(() => chatConversationCommand("/state", "$(id)")).toThrow();
    });

    it("stops Chat's agent before it resumes the conversation Chat last had, on a key", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-hold-"));
        const bin = join(dir, "bin");
        execFileSync("mkdir", ["-p", bin, join(dir, "acp")]);
        const log = join(dir, "log");
        // tmux stands in as a logger; launch.sh records what it was asked to resume.
        writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "tmux $*" >> "${log}"\n`);
        chmodSync(join(bin, "tmux"), 0o755);
        writeFileSync(join(dir, "launch.sh"), `echo "launch $1" >> "${log}"\n`);
        writeFileSync(join(dir, "hook.sh"), "cat > /dev/null\n");
        writeFileSync(join(dir, "acp", "generation"), "1");
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, POLARIS_STATE_DIR: dir };

        execFileSync("sh", ["-c", chatHoldCommand(dir, "conv-old")], { env });
        expect(readFileSync(log, "utf8")).toContain(`send-keys -t polaris-agent -l sh "${dir}/chat-hold.sh"`);

        // Chat reopened under another id meanwhile; that is the one resumed.
        execFileSync("sh", ["-c", chatConversationCommand(dir, "conv-new")], { env });
        execFileSync("sh", [join(dir, "chat-hold.sh")], { env, input: "x" });
        const lines = readFileSync(log, "utf8").trim().split("\n");
        const stopped = lines.findIndex((line) => line.includes("kill-window"));
        const resumed = lines.indexOf("launch conv-new");
        expect(stopped).toBeGreaterThan(0);
        expect(resumed).toBeGreaterThan(stopped);
        expect(existsSync(join(dir, "acp", "generation"))).toBe(false);
        expect(existsSync(join(dir, TERMINAL_BACK_FILE))).toBe(true);
        // The lock is given back before the terminal's agent takes the window.
        expect(existsSync(join(dir, AGENT_LOCK_DIR))).toBe(false);

        // The mark stays for every check until the session goes to Chat again.
        expect(execFileSync("sh", ["-c", terminalBackCommand(dir)], { env }).toString().trim()).toBe(TERMINAL_BACK);
        expect(execFileSync("sh", ["-c", terminalBackCommand(dir)], { env }).toString().trim()).toBe(TERMINAL_BACK);
        execFileSync("sh", ["-c", chatEntryCommand(dir)], { env });
        expect(execFileSync("sh", ["-c", terminalBackCommand(dir)], { env }).toString().trim()).toBe("");
        expect(existsSync(join(dir, CHAT_CONVERSATION_FILE))).toBe(false);
    });

    it("tells the dashboard through the session's hook that the terminal has it", async () => {
        const box = shellBox();
        const report = join(box.dir, "report");
        mkdirSync(join(box.dir, "acp"));
        writeFileSync(join(box.dir, "launch.sh"), "");
        writeFileSync(join(box.dir, "hook.sh"), `cat > "${report}.part"; mv "${report}.part" "${report}"\n`);
        expect(await box.run(chatHoldCommand(box.dir, "conv"))).toBe(0);
        execFileSync("sh", [join(box.dir, "chat-hold.sh")], { env: box.env, input: "x" });
        // In the background: wait for it rather than for the script.
        for (let i = 0; i < 50 && !existsSync(report); i++) await new Promise((done) => setTimeout(done, 100));
        expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ hook_event_name: TERMINAL_BACK_EVENT });
    });

    it("leaves a session with a runner to its own hand-back", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-hold-"));
        writeFileSync(join(dir, "runner.ready"), "");
        execFileSync("sh", ["-c", chatHoldCommand(dir, "conv")]);
        expect(existsSync(join(dir, "chat-hold.sh"))).toBe(false);
    });

    it("ends only a script still waiting for its key", () => {
        expect(chatHoldStopCommand()).toContain("[c]hat-hold[.]sh");
        expect(() => execFileSync("sh", ["-c", chatHoldStopCommand()])).not.toThrow();
    });
});

/** A shell under a stand-in tmux that logs what it is asked, in a fresh
 *  state directory. */
function shellBox() {
    const dir = mkdtempSync(join(tmpdir(), "polaris-lock-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "tmux $*" >> "${log}"\n`);
    chmodSync(join(bin, "tmux"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, POLARIS_STATE_DIR: dir };
    const run = (script: string) =>
        new Promise<number>((done) => {
            execFile("sh", ["-c", script], { env }, (error) => done(error ? Number(error.code ?? 1) : 0));
        });
    const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    return { dir, env, log, run, logged };
}

describe("the agent lock", () => {
    it("lets one of two racing starts in at a time", async () => {
        const box = shellBox();
        const holder = (name: string) =>
            `${agentLockCommand(box.dir)}\necho "${name} in" >> "${box.log}"\nsleep 1\necho "${name} out" >> "${box.log}"`;
        expect(await Promise.all([box.run(holder("a")), box.run(holder("b"))])).toEqual([0, 0]);
        const lines = box.logged().trim().split("\n");
        expect(lines).toHaveLength(4);
        // Whoever went in first came out before the other went in.
        expect(lines[1]).toBe(lines[0]!.replace(" in", " out"));
        expect(existsSync(join(box.dir, AGENT_LOCK_DIR))).toBe(false);
    });

    it("breaks a lock whose holder died without giving it back", async () => {
        const box = shellBox();
        const lock = join(box.dir, AGENT_LOCK_DIR);
        mkdirSync(lock);
        const tenMinutesAgo = Date.now() / 1000 - 600;
        utimesSync(lock, tenMinutesAgo, tenMinutesAgo);
        expect(await box.run(`${agentLockCommand(box.dir)}\necho in >> "${box.log}"`)).toBe(0);
        expect(box.logged()).toBe("in\n");
        expect(existsSync(lock)).toBe(false);
    });
});

describe("a protocol launch once the terminal took the session back", () => {
    const stop = (log: string) => `echo stopped >> "${log}"`;

    it("starts nothing and stops nothing while the mark is there", async () => {
        const box = shellBox();
        writeFileSync(join(box.dir, TERMINAL_BACK_FILE), "");
        expect(await box.run(acpLaunchCommand(box.dir, ["agent"], "polaris-agent", stop(box.log)))).toBe(ACP_TERMINAL_BACK);
        expect(box.logged()).toBe("");
        expect(existsSync(join(box.dir, AGENT_LOCK_DIR))).toBe(false);
    });

    it("waits for a key that holds the lock, then sees what it did", async () => {
        const box = shellBox();
        const lock = join(box.dir, AGENT_LOCK_DIR);
        mkdirSync(lock);
        const launch = box.run(acpLaunchCommand(box.dir, ["agent"], "polaris-agent", stop(box.log)));
        await new Promise((done) => setTimeout(done, 600));
        expect(box.logged()).toBe("");
        // The key side, inside its lock: the mark, then the lock given back.
        writeFileSync(join(box.dir, TERMINAL_BACK_FILE), "");
        rmdirSync(lock);
        expect(await launch).toBe(ACP_TERMINAL_BACK);
        expect(box.logged()).toBe("");
    });

    it("stops the terminal's agent, then opens the window, without the mark", async () => {
        const box = shellBox();
        expect(await box.run(acpLaunchCommand(box.dir, ["agent"], "polaris-agent", stop(box.log)))).toBe(0);
        const lines = box.logged().trim().split("\n");
        expect(lines[0]).toBe("stopped");
        expect(lines.at(-1)).toContain("new-window");
        expect(existsSync(join(box.dir, AGENT_LOCK_DIR))).toBe(false);
    });
});
