import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as commands from "@/lib/agents/session-commands";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { claudeHookSettings, hookScript, normalizeHookEvent } from "@/lib/agents/session-hooks";
import { hasHookActivity, hookActivity, sessionEndIsSwap } from "@/lib/agents/hook-activity";

const relay = (event: string): string =>
    `export POLARIS_HOOK_EVENT=${event}; ${core.AGENT_HOOK_RELAY}`;

const group = (event: string, timeout: number, matcher?: string): Record<string, unknown> => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: relay(event), timeout }]
});

function cli(id: string): core.AgentCli {
    const found = core.AGENT_CLIS.find((entry) => entry.id === id);
    if (!found) throw new Error(id);
    return found;
}

describe("hook file rendering, per tool", () => {
    it("Qwen Code: settings.json in the checkout, matcher groups, milliseconds", () => {
        expect(core.hookFileAnswer("qwen")).toEqual({
            file: "{workdir}/.qwen/settings.json",
            assert: {
                hooks: {
                    SessionStart: [group("SessionStart", 30000, "startup|resume")],
                    UserPromptSubmit: [group("UserPromptSubmit", 30000)],
                    PermissionRequest: [group("PermissionRequest", 30000)],
                    Stop: [group("Stop", 30000)]
                }
            }
        });
    });

    it("Goose: its own plugin folder", () => {
        expect(core.hookFileAnswer("goose")).toEqual({
            file: "{workdir}/.agents/plugins/polaris/hooks/hooks.json",
            assert: {
                hooks: {
                    SessionStart: [group("SessionStart", 30)],
                    UserPromptSubmit: [group("UserPromptSubmit", 30)],
                    Stop: [group("Stop", 30)]
                }
            }
        });
    });

    it("Droid: .factory/hooks.json with notification and session end", () => {
        expect(core.hookFileAnswer("droid")?.assert).toEqual({
            hooks: {
                SessionStart: [group("SessionStart", 30, "startup")],
                UserPromptSubmit: [group("UserPromptSubmit", 30)],
                Stop: [group("Stop", 30)],
                Notification: [group("Notification", 30)],
                SessionEnd: [group("SessionEnd", 30)]
            }
        });
        expect(core.hookFileAnswer("droid")?.file).toBe("{workdir}/.factory/hooks.json");
    });

    it("OpenHands: the wrapped PascalCase form", () => {
        expect(core.hookFileAnswer("openhands")).toEqual({
            file: "{workdir}/.openhands/hooks.json",
            assert: {
                hooks: {
                    SessionStart: [group("SessionStart", 30)],
                    UserPromptSubmit: [group("UserPromptSubmit", 30)],
                    Stop: [group("Stop", 30)]
                }
            }
        });
    });

    it("Kimchi: hooks.local.json, its failure event named in its own words", () => {
        const answer = core.hookFileAnswer("kimchi");
        expect(answer?.file).toBe("{workdir}/.kimchi/hooks.local.json");
        const hooks = (answer?.assert as { hooks: Record<string, unknown> }).hooks;
        expect(Object.keys(hooks)).toEqual([
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "SessionEnd",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFail"
        ]);
        expect(hooks.PostToolUseFail).toEqual([group("PostToolUseFailure", 30)]);
        expect(hooks.SessionStart).toEqual([group("SessionStart", 30, "startup")]);
    });

    it("Devin: config.local.json", () => {
        const answer = core.hookFileAnswer("devin");
        expect(answer?.file).toBe("{workdir}/.devin/config.local.json");
        expect(Object.keys((answer?.assert as { hooks: object }).hooks)).toEqual([
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "SessionEnd"
        ]);
    });

    it("Command Code: settings.json with the tool events", () => {
        const answer = core.hookFileAnswer("command-code");
        expect(answer?.file).toBe("{workdir}/.commandcode/settings.json");
        expect((answer?.assert as { hooks: Record<string, unknown> }).hooks.PreToolUse).toEqual([
            group("PreToolUse", 30)
        ]);
    });

    it("Cursor: version 1, bare commands, and none of the permission gates", () => {
        const answer = core.hookFileAnswer("cursor");
        expect(answer?.file).toBe("{workdir}/.cursor/hooks.json");
        // Filled in, never asserted: a version the repository's file declares stays.
        expect(answer?.json).toEqual({ version: 1 });
        const hooks = (answer?.assert as { hooks: Record<string, unknown> }).hooks;
        expect(hooks.beforeSubmitPrompt).toEqual([{ command: relay("UserPromptSubmit") }]);
        expect(hooks.afterShellExecution).toEqual([{ command: relay("PostToolUse") }]);
        expect(hooks.beforeShellExecution).toBeUndefined();
        expect(hooks.beforeMCPExecution).toBeUndefined();
    });

    it("Antigravity: one named entry holding bare entries and a matcher group", () => {
        const entry = (event: string) => ({ type: "command", command: relay(event), timeout: 30 });
        expect(core.hookFileAnswer("agy")).toEqual({
            file: "{workdir}/.agents/hooks.json",
            assert: {
                polaris: {
                    PreInvocation: [entry("PreInvocation")],
                    PostToolUse: [{ matcher: "*", hooks: [entry("PostToolUse")] }],
                    Stop: [entry("Stop")]
                }
            }
        });
    });

    it("Autohand: its home config, a list of event entries", () => {
        const answer = core.hookFileAnswer("autohand");
        expect(answer?.file).toBe(".autohand/config.json");
        const section = (answer?.assert as { hooks: { enabled: boolean; hooks: unknown[] } }).hooks;
        expect(section.enabled).toBe(true);
        expect(section.hooks[1]).toEqual({
            event: "pre-prompt",
            command: relay("UserPromptSubmit"),
            description: "Polaris session status",
            enabled: true,
            timeout: 30
        });
    });

    it("every tool in the table is in the catalogue, observed through hooks", () => {
        for (const id of Object.keys(core.AGENT_HOOK_FILES)) {
            expect(cli(id).observe, id).toBe("hooks");
            expect(cli(id).firstRun, id).toEqual([core.hookFileAnswer(id)]);
            expect(hasHookActivity(id), id).toBe(true);
        }
        // And every tool observed through hooks has its events read.
        for (const entry of core.AGENT_CLIS)
            if (entry.observe === "hooks") expect(hasHookActivity(entry.id), entry.id).toBe(true);
    });

    it("stamps only names the hook script lets through and the event reader knows", () => {
        for (const [id, spec] of Object.entries(core.AGENT_HOOK_FILES)) {
            for (const registration of spec.events) {
                const name = core.HOOK_SIGNAL_EVENTS[registration.signal];
                expect(name, id).toMatch(/^[A-Za-z]+$/);
                expect(core.hookSignalOf(name)).toBe(registration.signal);
            }
        }
        // Every stamped name but Antigravity's per-invocation one becomes an event.
        for (const signal of core.HOOK_SIGNALS) {
            const event = core.HOOK_SIGNAL_EVENTS[signal];
            const read = normalizeHookEvent({ hook_event_name: event });
            if (signal === "pre-invocation") expect(read).toBeNull();
            else expect(read, signal).not.toBeNull();
        }
        expect(normalizeHookEvent({ hook_event_name: "PostToolUseFailure", tool_name: "Bash" })).toEqual(
            { kind: "tool.failed", detail: "Bash", subject: "Bash" }
        );
    });

    it("leaves Claude Code's settings exactly as they were", () => {
        const settings = claudeHookSettings("/state/hook.sh") as {
            hooks: Record<string, unknown[]>;
        };
        expect(settings.hooks.PreToolUse).toEqual([
            { matcher: "*", hooks: [{ type: "command", command: "/state/hook.sh", timeout: 130 }] }
        ]);
        expect(settings.hooks.Stop).toEqual([
            { hooks: [{ type: "command", command: "/state/hook.sh", timeout: 5 }] }
        ]);
    });
});

describe("writing a hook file into the checkout", () => {
    function repo(): { home: string; workdir: string } {
        const root = mkdtempSync(join(tmpdir(), "polaris-hooks-"));
        const home = join(root, "home");
        const workdir = join(root, "repo");
        mkdirSync(home, { recursive: true });
        mkdirSync(workdir, { recursive: true });
        spawnSync("git", ["init", "-q", workdir]);
        return { home, workdir };
    }

    function run(home: string, workdir: string, answers: readonly core.AgentFirstRunAnswer[]) {
        const list = join(home, "answers.json");
        writeFileSync(list, JSON.stringify(answers));
        const done = spawnSync(process.execPath, ["-e", commands.firstRunProgram(), list], {
            encoding: "utf8",
            env: { ...process.env, HOME: home, POLARIS_WORKDIR: workdir }
        });
        expect(done.status, done.stderr).toBe(0);
        return done.stdout;
    }

    const git = (workdir: string, ...args: string[]): string =>
        spawnSync("git", ["-C", workdir, ...args], { encoding: "utf8" }).stdout;

    it("writes it under the worktree and keeps it out of the repository's changes", () => {
        const { home, workdir } = repo();
        const said = run(home, workdir, cli("qwen").firstRun);
        expect(said).toContain("answered its first run");
        const written = JSON.parse(readFileSync(join(workdir, ".qwen/settings.json"), "utf8"));
        expect(written).toEqual(core.hookFileAnswer("qwen")?.assert);
        expect(git(workdir, "status", "--porcelain")).toBe("");
        // Again: nothing to do, nothing said, the exclude line not doubled.
        expect(run(home, workdir, cli("qwen").firstRun)).not.toContain("answered");
        const exclude = readFileSync(join(workdir, ".git/info/exclude"), "utf8");
        expect(exclude.split("\n").filter((line) => line === "/.qwen/settings.json")).toHaveLength(1);
    });

    it("keeps a repository's own hooks for the same event, and our edit out of its commits", () => {
        const { home, workdir } = repo();
        const theirs = { hooks: [{ type: "command", command: "make lint" }] };
        mkdirSync(join(workdir, ".qwen"), { recursive: true });
        writeFileSync(
            join(workdir, ".qwen/settings.json"),
            JSON.stringify({ model: "x", hooks: { Stop: [theirs] } })
        );
        git(workdir, "add", ".qwen/settings.json");
        git(workdir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "x");

        run(home, workdir, cli("qwen").firstRun);
        const written = JSON.parse(readFileSync(join(workdir, ".qwen/settings.json"), "utf8"));
        expect(written.model).toBe("x");
        expect(written.hooks.Stop).toEqual([theirs, group("Stop", 30000)]);
        // Tracked: git leaves the edit out of what it stages.
        expect(git(workdir, "status", "--porcelain")).toBe("");
        // A second run finds ours already there and theirs still first.
        run(home, workdir, cli("qwen").firstRun);
        const again = JSON.parse(readFileSync(join(workdir, ".qwen/settings.json"), "utf8"));
        expect(again.hooks.Stop).toEqual([theirs, group("Stop", 30000)]);
    });

    it("skips a checkout file where there is no worktree, and still writes the home one", () => {
        const { home } = repo();
        const said = run(home, "", [...cli("qwen").firstRun, ...cli("autohand").firstRun]);
        expect(said.match(/answered/g)).toHaveLength(1);
        const config = JSON.parse(readFileSync(join(home, ".autohand/config.json"), "utf8"));
        expect(config.hooks.hooks).toHaveLength(4);
    });
});

describe("hook event -> activity", () => {
    const stamped = (event: string, extra: Record<string, unknown> = {}) => ({
        hook_event_name: event,
        ...extra
    });

    it("the shared mapping (Qwen, Goose, OpenHands, Devin, Autohand)", () => {
        for (const id of ["qwen", "goose", "openhands", "devin", "autohand"]) {
            expect(hookActivity(id, stamped("SessionStart")), id).toBe("active");
            expect(hookActivity(id, stamped("UserPromptSubmit")), id).toBe("active");
            expect(hookActivity(id, stamped("Stop")), id).toBe("idle");
            expect(hookActivity(id, stamped("PermissionRequest")), id).toBe("waiting_input");
            expect(hookActivity(id, stamped("SessionEnd")), id).toBeNull();
        }
    });

    it("Claude Code reads the payload", () => {
        expect(hookActivity("claude", stamped("PermissionRequest"))).toBe("blocked");
        expect(hookActivity("claude", stamped("StopFailure"))).toBe("idle");
        expect(
            hookActivity("claude", stamped("Notification", { notification_type: "permission_prompt" }))
        ).toBe("blocked");
        expect(
            hookActivity("claude", stamped("Notification", { notification_type: "idle_prompt" }))
        ).toBe("idle");
        expect(hookActivity("claude", stamped("SessionEnd", { reason: "clear" }))).toBeNull();
        expect(hookActivity("claude", stamped("SessionEnd", { reason: "logout" }))).toBe("exited");
        expect(hookActivity("claude", stamped("SubagentStart"))).toBeNull();
    });

    it("Codex, Gemini CLI and Copilot CLI in their own event names", () => {
        expect(hookActivity("codex", stamped("PermissionRequest"))).toBe("waiting_input");
        expect(hookActivity("codex", stamped("PreToolUse"))).toBeNull();
        expect(hookActivity("gemini", stamped("BeforeAgent"))).toBe("active");
        expect(hookActivity("gemini", stamped("AfterAgent"))).toBe("idle");
        expect(
            hookActivity("gemini", stamped("Notification", { notification_type: "ToolPermission" }))
        ).toBe("waiting_input");
        expect(hookActivity("copilot", stamped("agentStop"))).toBe("idle");
        expect(hookActivity("copilot", stamped("permissionRequest"))).toBe("waiting_input");
    });

    it("Droid and Kimchi: notifications and which session ends are real", () => {
        expect(hookActivity("droid", stamped("Notification"))).toBe("waiting_input");
        expect(hookActivity("droid", stamped("SessionEnd", { reason: "clear" }))).toBeNull();
        expect(hookActivity("droid", stamped("SessionEnd", { reason: "exit" }))).toBe("exited");
        expect(hookActivity("kimchi", stamped("PostToolUseFailure"))).toBe("active");
        expect(
            hookActivity("kimchi", stamped("Notification", { notification_type: "agent_needs_input" }))
        ).toBe("waiting_input");
        expect(hookActivity("kimchi", stamped("SessionEnd", { reason: "fork" }))).toBeNull();
        expect(sessionEndIsSwap("kimchi", { reason: "reload" })).toBe(true);
        expect(sessionEndIsSwap("droid", { reason: "reload" })).toBe(false);
        expect(sessionEndIsSwap("codex", { reason: "clear" })).toBe(false);
    });

    it("Antigravity, Command Code and Cursor", () => {
        expect(hookActivity("agy", stamped("PreInvocation"))).toBe("active");
        expect(hookActivity("agy", stamped("Stop"))).toBe("idle");
        expect(hookActivity("command-code", stamped("SessionStart"))).toBeNull();
        expect(hookActivity("command-code", stamped("PostToolUse"))).toBe("active");
        expect(hookActivity("cursor", stamped("PostToolUseFailure"))).toBe("active");
        expect(hookActivity("cursor", stamped("Stop"))).toBe("idle");
    });

    it("says nothing for a tool without hooks or a payload that is not an object", () => {
        expect(hookActivity("aider", stamped("Stop"))).toBeNull();
        expect(hookActivity("qwen", null)).toBeNull();
        expect(hookActivity("qwen", ["Stop"])).toBeNull();
    });
});

describe("the event name a registration stamps on the payload", () => {
    // The stamping part of the hook script, run on its own: everything after it
    // posts to Polaris.
    const lines = hookScript("http://127.0.0.1:1/ingest", "token").split("\n");
    const from = lines.findIndex((line) => line.startsWith("payload="));
    const to = lines.findIndex((line, index) => index > from && line === "fi");
    const snippet = [...lines.slice(from, to + 1), 'printf %s "$payload"'].join("\n");
    const stamp = (input: string, event: string): unknown =>
        JSON.parse(
            spawnSync("sh", ["-c", snippet], {
                input,
                encoding: "utf8",
                env: { ...process.env, POLARIS_HOOK_EVENT: event }
            }).stdout
        );

    it("wins over the tool's own name for the event", () => {
        expect(stamp('{"hook_event_name":"PostToolUseFail","x":1}  \n', "PostToolUseFailure")).toEqual({
            hook_event_name: "PostToolUseFailure",
            x: 1
        });
    });

    it("stands alone on an empty payload and leaves the rest untouched", () => {
        expect(stamp("", "Stop")).toEqual({ hook_event_name: "Stop" });
        expect(stamp("{}", "Stop")).toEqual({ hook_event_name: "Stop" });
        expect(stamp('{"a":"}"}', "Stop")).toEqual({ a: "}", hook_event_name: "Stop" });
    });

    it("is not stamped when the name is anything but letters", () => {
        expect(stamp('{"a":1}', "bad-1")).toEqual({ a: 1 });
    });
});
