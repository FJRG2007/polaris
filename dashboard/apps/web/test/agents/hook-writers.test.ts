import ts from "typescript";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "@polaris/core";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { hookActivity } from "@/lib/agents/hook-activity";
import * as commands from "@/lib/agents/session-commands";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";

const relay = (event: string): string => `export POLARIS_HOOK_EVENT=${event}; ${core.AGENT_HOOK_RELAY}`;

function scratch(): { home: string; workdir: string; state: string } {
    const root = mkdtempSync(join(tmpdir(), "polaris-hook-writers-"));
    const home = join(root, "home");
    const workdir = join(root, "repo");
    const state = join(root, "state");
    for (const dir of [home, workdir, state]) mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", workdir]);
    return { home, workdir, state };
}

function run(home: string, workdir: string, answers: readonly core.AgentFirstRunAnswer[]): string {
    const list = join(home, "answers.json");
    writeFileSync(list, JSON.stringify(answers));
    const done = spawnSync(process.execPath, ["-e", commands.firstRunProgram(), list], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, POLARIS_WORKDIR: workdir }
    });
    expect(done.status, done.stderr).toBe(0);
    return done.stdout;
}

const excluded = (workdir: string): string[] =>
    readFileSync(join(workdir, ".git", "info", "exclude"), "utf8").split("\n");

describe("TOML hook blocks", () => {
    it("Kimi Code: eight [[hooks]] tables in its home config.toml", () => {
        const [answer] = core.hookFileAnswers("kimi");
        expect(answer!.file).toBe(".kimi-code/config.toml");
        const tables = answer!.block!.trim().split("\n\n");
        expect(tables).toHaveLength(8);
        expect(tables[0]).toBe(
            [
                "[[hooks]]",
                'event = "SessionStart"',
                'matcher = "startup"',
                `command = ${JSON.stringify(relay("SessionStart"))}`,
                "timeout = 5"
            ].join("\n")
        );
        expect(tables[6]).toContain('event = "PermissionResult"');
        expect(tables[6]).toContain(JSON.stringify(relay("PermissionResolved")));
    });

    it("Vibe: three named hooks in the checkout's .vibe/hooks.toml", () => {
        const [answer] = core.hookFileAnswers("vibe");
        expect(answer!.file).toBe("{workdir}/.vibe/hooks.toml");
        expect(answer!.block).toContain('type = "post_agent"');
        expect(answer!.block).toContain('type = "pre_tool"\nmatch = "*"');
        expect(answer!.block!.match(/^\[\[hooks\]\]$/gm)).toHaveLength(3);
    });

    it("quotes a string the way TOML reads it back", () => {
        expect(core.tomlString('a "b" \\ c\n')).toBe('"a \\"b\\" \\\\ c\\n"');
    });

    it("adds the block after the person's own lines, then replaces only it", () => {
        const { home, workdir } = scratch();
        const file = join(workdir, ".vibe", "hooks.toml");
        mkdirSync(join(workdir, ".vibe"));
        writeFileSync(file, '[[hooks]]\nname = "mine"\ntype = "pre_tool"\ncommand = "echo hi"\n');
        const answers = core.hookFileAnswers("vibe");

        expect(run(home, workdir, answers)).toContain("answered its first run");
        const first = readFileSync(file, "utf8");
        expect(first.startsWith('[[hooks]]\nname = "mine"')).toBe(true);
        expect(first).toContain(`${core.HOOK_BLOCK_START}\n\n[[hooks]]\nname = "polaris-post-agent"`);
        expect(first.endsWith(`${core.HOOK_BLOCK_END}\n`)).toBe(true);
        expect(excluded(workdir)).toContain("/.vibe/hooks.toml");

        // The same block again: nothing to write, nothing said.
        expect(run(home, workdir, answers)).toBe("");
        // A changed block is replaced where it is; lines after it survive.
        writeFileSync(file, `${first.replace("timeout = 30", "timeout = 1")}\n# after\n`);
        run(home, workdir, answers);
        const again = readFileSync(file, "utf8");
        expect(again.split(core.HOOK_BLOCK_START)).toHaveLength(2);
        expect(again).not.toContain("timeout = 1\n");
        expect(again.endsWith(`${core.HOOK_BLOCK_END}\n\n# after\n`)).toBe(true);
    });

    it("writes Kimi's into the home even where there is no worktree", () => {
        const { home } = scratch();
        run(home, "", core.hookFileAnswers("kimi"));
        const text = readFileSync(join(home, ".kimi-code", "config.toml"), "utf8");
        expect(text.startsWith(core.HOOK_BLOCK_START)).toBe(true);
    });
});

describe("files Polaris owns whole", () => {
    it("Auggie: one executable relay script per event, run by absolute path", () => {
        const { home, workdir } = scratch();
        run(home, workdir, core.hookFileAnswers("auggie"));
        const script = join(workdir, ".augment", "polaris-hooks", "stop");
        expect(readFileSync(script, "utf8")).toBe(core.hookRelayScript("stop"));
        if (process.platform !== "win32") expect(statSync(script).mode & 0o111).not.toBe(0);
        const settings = JSON.parse(readFileSync(join(workdir, ".augment", "settings.local.json"), "utf8"));
        expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: script, timeout: 5000 }] }]);
        expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]);
        expect(excluded(workdir)).toEqual(expect.arrayContaining(["/.augment/polaris-hooks/stop", "/.augment/settings.local.json"]));
    });

    it("Auggie: keeps a person's own hook beside ours, once", () => {
        const { home, workdir } = scratch();
        mkdirSync(join(workdir, ".augment"));
        const mine = { hooks: [{ type: "command", command: "/usr/local/bin/notify" }] };
        writeFileSync(join(workdir, ".augment", "settings.local.json"), JSON.stringify({ hooks: { Stop: [mine] } }));
        run(home, workdir, core.hookFileAnswers("auggie"));
        run(home, workdir, core.hookFileAnswers("auggie"));
        const settings = JSON.parse(readFileSync(join(workdir, ".augment", "settings.local.json"), "utf8"));
        expect(settings.hooks.Stop).toHaveLength(2);
        expect(settings.hooks.Stop[0]).toEqual(mine);
    });

    it("never overwrites a file of the same name somebody else wrote", () => {
        const { home, workdir } = scratch();
        const file = join(workdir, ".opencode", "plugins", "polaris-activity.ts");
        mkdirSync(join(workdir, ".opencode", "plugins"), { recursive: true });
        writeFileSync(file, "export const Mine = 1;\n");
        expect(run(home, workdir, core.hookFileAnswers("opencode"))).toContain("left");
        expect(readFileSync(file, "utf8")).toBe("export const Mine = 1;\n");
    });

    it("the Pi family loads by path the file it writes, outside the folders it scans", () => {
        for (const id of ["pi", "omp", "prime-agent"]) {
            const entry = core.AGENT_CLIS.find((cli) => cli.id === id)!;
            const [answer] = core.hookFileAnswers(id);
            expect(entry.hookArgs, id).toEqual(["--extension", answer!.file.replace(core.HOOK_FILE_WORKDIR, "")]);
            expect(answer!.file.startsWith("{workdir}/.polaris/hooks/"), id).toBe(true);
        }
    });

    it("rewrites its own plugin and keeps it out of commits", () => {
        const { home, workdir } = scratch();
        const file = join(workdir, ".kilocode", "plugins", "polaris-activity.ts");
        mkdirSync(join(workdir, ".kilocode", "plugins"), { recursive: true });
        writeFileSync(file, `// old\nconst RELAY = "POLARIS_STATE_DIR";\n`);
        run(home, workdir, core.hookFileAnswers("kilocode"));
        expect(readFileSync(file, "utf8")).toBe(core.hookFileAnswers("kilocode")[0]!.text);
        expect(excluded(workdir)).toContain("/.kilocode/plugins/polaris-activity.ts");
    });
});

/**
 * Compiles a plugin the way the tool would load it and drives it with events,
 * through a relay whose hook script records what reached it.
 */
async function drive(source: string, state: string): Promise<Record<string, any>> {
    const out = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        reportDiagnostics: true
    });
    expect(out.diagnostics ?? []).toEqual([]);
    const file = join(state, `plugin-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, out.outputText);
    return import(/* @vite-ignore */ pathToFileURL(file).href);
}

function recorder(state: string): () => Array<{ event: string; payload: Record<string, unknown> }> {
    const log = join(state, "log");
    writeFileSync(
        join(state, "hook.sh"),
        `#!/bin/sh\nprintf '%s %s\\n' "$POLARIS_HOOK_EVENT" "$(cat)" >> "${log.replace(/\\/g, "/")}"\n`,
        { mode: 0o755 }
    );
    return () =>
        existsSync(log)
            ? readFileSync(log, "utf8")
                  .trim()
                  .split("\n")
                  .map((line) => {
                      const space = line.indexOf(" ");
                      return { event: line.slice(0, space), payload: JSON.parse(line.slice(space + 1)) };
                  })
            : [];
}

describe("the plugins, run", () => {
    it("every plugin source compiles", () => {
        for (const id of Object.keys(core.AGENT_HOOK_WRITERS)) {
            for (const answer of core.hookFileAnswers(id)) {
                if (!answer.file.endsWith(".ts")) continue;
                const out = ts.transpileModule(answer.text!, { reportDiagnostics: true, compilerOptions: {} });
                expect(out.diagnostics ?? [], id).toEqual([]);
            }
        }
    });

    it("OpenCode: one session start, one prompt per message, subagents left out", async () => {
        const { state } = scratch();
        const read = recorder(state);
        const previous = process.env.POLARIS_STATE_DIR;
        process.env.POLARIS_STATE_DIR = state;
        try {
            const plugin = await drive(core.hookFileAnswers("opencode")[0]!.text!, state);
            const hooks = await plugin.PolarisActivity({});
            const send = (type: string, properties: unknown) => hooks.event({ event: { type, properties } });
            await send("session.created", { info: { id: "s1" } });
            await send("session.created", { info: { id: "child", parentID: "s1" } });
            await send("message.updated", { info: { id: "m1", sessionID: "s1", role: "user" } });
            await send("message.part.updated", { part: { messageID: "m1", type: "text", text: "fix it" } });
            await hooks["tool.execute.before"]({ sessionID: "child", tool: "bash" });
            await send("permission.asked", { sessionID: "s1" });
            await send("permission.replied", { sessionID: "s1" });
            await send("session.status", { sessionID: "child", status: { type: "idle" } });
            await send("session.status", { sessionID: "s1", status: { type: "idle" } });
            const events = read();
            expect(events.map((entry) => entry.event)).toEqual([
                "SessionStart",
                "UserPromptSubmit",
                "UserPromptSubmit",
                "PreToolUse",
                "PermissionRequest",
                "PermissionResolved",
                "Stop"
            ]);
            expect(events[2]!.payload).toEqual({ session_id: "s1", prompt: "fix it" });
            // A subagent's tool call is reported as the session's own.
            expect(events[3]!.payload).toEqual({ session_id: "s1", tool_name: "bash" });
            expect(events.map((entry) => hookActivity("opencode", { ...entry.payload, hook_event_name: entry.event })))
                .toEqual(["active", "active", "active", "active", "blocked", "active", "idle"]);
        } finally {
            if (previous === undefined) delete process.env.POLARIS_STATE_DIR;
            else process.env.POLARIS_STATE_DIR = previous;
        }
    });

    it("Oh My Pi: approvals reported, a continuing run not stopped, a reload not an exit", async () => {
        const { state } = scratch();
        const read = recorder(state);
        const previous = process.env.POLARIS_STATE_DIR;
        process.env.POLARIS_STATE_DIR = state;
        try {
            const plugin = await drive(core.hookFileAnswers("omp")[0]!.text!, state);
            const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
            plugin.default({ on: (name: string, handler: any) => (handlers[name] = handler) });
            const ctx = { sessionManager: { getSessionId: () => "pi-1" } };
            await handlers.session_start!({}, ctx);
            await handlers.before_agent_start!({ prompt: "go" }, ctx);
            await handlers.tool_approval_requested!({ toolName: "bash" }, ctx);
            await handlers.tool_approval_resolved!({ toolName: "bash" }, ctx);
            await handlers.agent_end!({ willContinue: true }, ctx);
            await handlers.agent_end!({}, ctx);
            await handlers.session_shutdown!({ reason: "reload" }, ctx);
            await handlers.session_shutdown!({ reason: "quit" }, ctx);
            const events = read();
            expect(events.map((entry) => entry.event)).toEqual([
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "PermissionResolved",
                "Stop",
                "SessionEnd"
            ]);
            expect(events.map((entry) => hookActivity("omp", { ...entry.payload, hook_event_name: entry.event })))
                .toEqual(["idle", "active", "waiting_input", "active", "idle", "exited"]);
        } finally {
            if (previous === undefined) delete process.env.POLARIS_STATE_DIR;
            else process.env.POLARIS_STATE_DIR = previous;
        }
    });
});

describe("hook event -> activity, the tools written from AGENT_HOOK_WRITERS", () => {
    const at = (cli: string, event: string, extra: Record<string, unknown> = {}) =>
        hookActivity(cli, { hook_event_name: event, ...extra });

    it("Auggie reads why the turn stopped", () => {
        expect(at("auggie", "Stop", { agent_stop_cause: "end_turn" })).toBe("idle");
        expect(at("auggie", "Stop", { agent_stop_cause: "max_iterations" })).toBe("waiting_input");
        expect(at("auggie", "Stop")).toBeNull();
        expect(at("auggie", "SessionEnd")).toBe("exited");
    });

    it("Kimi Code clears a permission block when it is answered", () => {
        expect(at("kimi", "PermissionRequest")).toBe("blocked");
        expect(at("kimi", "PermissionResolved")).toBe("active");
        expect(at("kimi", "PostToolUseFailure")).toBe("active");
        expect(at("kimi", "Stop")).toBe("idle");
    });

    it("Vibe, Amp, Pi and Prime Agent", () => {
        expect(at("vibe", "PreToolUse")).toBe("active");
        expect(at("vibe", "Stop")).toBe("idle");
        expect(at("amp", "PreToolUse")).toBe("active");
        expect(at("amp", "PermissionRequest")).toBe("waiting_input");
        expect(at("amp", "Stop", { status: "error" })).toBe("waiting_input");
        expect(at("amp", "Stop")).toBe("idle");
        expect(at("pi", "SessionStart")).toBe("idle");
        expect(at("prime-agent", "UserPromptSubmit")).toBe("active");
        expect(at("mimo-code", "PermissionRequest")).toBe("blocked");
    });
});
