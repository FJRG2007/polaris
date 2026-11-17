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
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
    CHAT_CONVERSATION_FILE,
    chatConversationCommand,
    chatHoldCommand,
    chatHoldStopCommand,
    handsOff,
    remoteTurnRoute,
    TERMINAL_BACK,
    TERMINAL_BACK_FILE,
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

        // The next message reads the hand-back once.
        expect(execFileSync("sh", ["-c", terminalBackCommand(dir)], { env }).toString().trim()).toBe(TERMINAL_BACK);
        expect(existsSync(join(dir, CHAT_CONVERSATION_FILE))).toBe(false);
        expect(execFileSync("sh", ["-c", terminalBackCommand(dir)], { env }).toString().trim()).toBe("");
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
