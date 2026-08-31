/**
 * The commands a session is made of, and the hooks that report on it.
 *
 * None of this can be run here - it wants Docker, an enrolled server and
 * somebody's repository - so the builders are asserted instead. What is checked
 * is the part a reading would not catch: that nothing from a prompt reaches a
 * shell unquoted, that the boot script interpolates nothing at all, and that an
 * event Polaris does not recognise moves nothing.
 */

import { describe, expect, it } from "vitest";
import * as commands from "@/lib/agents/session-commands";
import { claudeHookSettings, hookEventFailed, hookScript, normalizeHookEvent, shellQuote } from "@/lib/agents/session-hooks";

const ESC = String.fromCharCode(27);

describe("the boot script", () => {
    it("interpolates nothing, so no repository name or prompt ever reaches a shell through it", () => {
        expect(commands.SESSION_BOOT).not.toMatch(/\$\{/);
    });

    it("reads every value it needs from the environment", () => {
        for (const name of [
            "GIT_AUTH_HEADER",
            "GITHUB_REPOSITORY",
            "POLARIS_WORKDIR",
            "POLARIS_BRANCH",
            "POLARIS_AGENT_COMMAND",
            "POLARIS_HOOK_SETTINGS"
        ]) {
            expect(commands.SESSION_BOOT).toContain(`$${name}`);
        }
    });

    it("drops the clone credential before the agent can read its own environment", () => {
        const boot = commands.SESSION_BOOT;
        expect(boot.indexOf("unset GIT_AUTH_HEADER")).toBeLessThan(boot.indexOf("tmux new-session"));
    });

    it("decodes the files it writes rather than carrying them raw", () => {
        // The bug this replaced: all three of these are files, every file has
        // newlines, and the host daemon refuses any environment value carrying a
        // control character - so every session on this box was refused before it
        // started, with a message naming a variable nobody had ever seen. They
        // travel base64 now, which that rule has nothing to object to.
        for (const name of ["POLARIS_HOOK_SCRIPT", "POLARIS_HOOK_SETTINGS", "POLARIS_MCP_CONFIG"]) {
            expect(commands.SESSION_BOOT).toContain(`printf %s "$${name}" | base64 -d`);
        }
    });

    it("writes the hooks into the worktree, never into the machine's own home", () => {
        expect(commands.SESSION_BOOT).toContain('"$POLARIS_WORKDIR/.claude/settings.local.json"');
        expect(commands.SESSION_BOOT).not.toContain('"$HOME/.claude');
    });

    it("keeps the container alive after the agent inside it exits", () => {
        expect(commands.SESSION_BOOT.trimEnd().endsWith("exec tail -f /dev/null")).toBe(true);
    });
});

describe("shellQuote", () => {
    it("makes a command substitution inert", () => {
        expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    });

    it("survives a quote of its own", () => {
        expect(shellQuote("it's")).toBe("'it'\\''s'");
    });
});

describe("steering a session", () => {
    it("pastes rather than types, so a newline in a prompt is text", () => {
        const command = commands.pastePromptCommand("line one\nline two");
        expect(command).toContain("paste-buffer -p");
        expect(command).toContain("line one\nline two");
    });

    it("quotes the prompt and makes its escapes inert, which are two different attacks", () => {
        const command = commands.pastePromptCommand(`'; rm -rf / #${ESC}[201~`);
        expect(command).not.toContain(ESC);
        expect(command).toContain("'\\''");
    });

    it("submits separately, because the paste has to land first", () => {
        expect(commands.submitCommand()).toContain("send-keys");
        expect(commands.submitCommand()).toContain("Enter");
        expect(commands.submitDelayMs("x")).toBeGreaterThanOrEqual(500);
        expect(commands.submitDelayMs("x".repeat(40_960))).toBeGreaterThan(commands.submitDelayMs("x"));
    });

    it("interrupts with Escape, not with the key that would quit", () => {
        expect(commands.interruptCommand()).toContain("Escape");
        expect(commands.interruptCommand()).not.toContain("C-c");
    });
});

describe("the hook script", () => {
    it("never puts the token on a command line an argument list would expose", () => {
        const script = hookScript("https://polaris.example/api/agents/sessions/s1/events", "tok_abc");
        expect(script).toContain("'Authorization: Bearer tok_abc'");
        expect(script).toContain("--data-binary @-");
    });

    it("always exits 0, so an unreachable Polaris never changes what an agent does", () => {
        expect(hookScript("https://x/y", "t").trimEnd().endsWith("exit 0")).toBe(true);
    });

    it("gives up quickly rather than holding the agent up", () => {
        expect(hookScript("https://x/y", "t")).toContain("-m 4");
    });
});

describe("claudeHookSettings", () => {
    it("registers the event that says the agent is blocked on a person", () => {
        const settings = claudeHookSettings("/w/.claude/polaris-hook.sh") as {
            hooks: Record<string, unknown[]>;
        };
        expect(Object.keys(settings.hooks)).toContain("Notification");
        expect(Object.keys(settings.hooks)).toContain("Stop");
    });

    it("watches every tool rather than a chosen few", () => {
        const settings = claudeHookSettings("/w/hook.sh") as {
            hooks: Record<string, { matcher?: string }[]>;
        };
        expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    });
});

describe("normalizeHookEvent", () => {
    it("says what a tool call is doing in one line", () => {
        expect(
            normalizeHookEvent({
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: "npm test" }
            })
        ).toEqual({ kind: "tool.start", detail: "Bash: npm test", subject: "Bash" });
    });

    it("falls back to the tool's name for one it does not know the shape of", () => {
        expect(
            normalizeHookEvent({ hook_event_name: "PreToolUse", tool_name: "SomeNewTool", tool_input: { a: 1 } })
        ).toEqual({ kind: "tool.start", detail: "SomeNewTool", subject: "SomeNewTool" });
    });

    it("maps the end of a turn and the moment it needs somebody to different states", () => {
        expect(normalizeHookEvent({ hook_event_name: "Stop" })?.kind).toBe("turn.end");
        expect(normalizeHookEvent({ hook_event_name: "Notification", message: "Needs permission" })).toEqual({
            kind: "question",
            detail: "Needs permission",
            subject: ""
        });
    });

    it("says nothing about an event nobody has mapped", () => {
        expect(normalizeHookEvent({ hook_event_name: "SomethingNew" })).toBeNull();
        expect(normalizeHookEvent("not an object")).toBeNull();
        expect(normalizeHookEvent(null)).toBeNull();
    });

    it("does not let a wall of output become the line on a screen", () => {
        const detail = normalizeHookEvent({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "x".repeat(5000) }
        })?.detail;
        expect(detail?.length).toBeLessThan(200);
    });
});

describe("hookEventFailed", () => {
    it("tells a tool that failed from one that worked", () => {
        expect(hookEventFailed({ tool_response: { success: false } })).toBe(true);
        expect(hookEventFailed({ tool_response: { error: "no such file" } })).toBe(true);
        expect(hookEventFailed({ tool_response: { output: "fine" } })).toBe(false);
        expect(hookEventFailed({})).toBe(false);
    });
});
