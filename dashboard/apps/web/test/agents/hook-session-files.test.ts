import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { hookActivity } from "@/lib/agents/hook-activity";
import * as commands from "@/lib/agents/session-commands";
import { sessionHookConfig } from "@/lib/agents/session-runtime";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { codewhaleHookPayload, codewhaleLifecycleSchema, codewhaleSequence } from "@/lib/agents/codewhale-lifecycle";

function scratch(): { home: string; workdir: string } {
    const root = mkdtempSync(join(tmpdir(), "polaris-hook-session-"));
    const home = join(root, "home");
    const workdir = join(root, "repo");
    for (const dir of [home, workdir]) mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", workdir]);
    return { home, workdir };
}

function run(home: string, workdir: string, answers: readonly core.AgentFirstRunAnswer[]): void {
    const list = join(home, "answers.json");
    writeFileSync(list, JSON.stringify(answers));
    const done = spawnSync(process.execPath, ["-e", commands.firstRunProgram(), list], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, POLARIS_WORKDIR: workdir }
    });
    expect(done.status, done.stderr).toBe(0);
}

const cli = (id: string): core.AgentCli => core.AGENT_CLIS.find((entry) => entry.id === id)!;
const at = (id: string, event: string) => hookActivity(id, { hook_event_name: event });

describe("Kiro", () => {
    it("a custom agent in the checkout holding four quiet hooks, selected on the launch", () => {
        const { home, workdir } = scratch();
        const file = join(workdir, ".kiro", "agents", "polaris.json");
        mkdirSync(join(workdir, ".kiro", "agents"), { recursive: true });
        // A person's own hook and description in the same file survive.
        writeFileSync(file, JSON.stringify({ description: "mine", hooks: { stop: [{ command: "notify" }] } }));
        run(home, workdir, core.hookFileAnswers("kiro"));
        const agent = JSON.parse(readFileSync(file, "utf8"));
        expect(agent.name).toBe("polaris");
        expect(agent.description).toBe("mine");
        expect(agent.tools).toEqual(["*"]);
        expect(Object.keys(agent.hooks).sort()).toEqual(["agentSpawn", "preToolUse", "stop", "userPromptSubmit"]);
        expect(agent.hooks.stop).toEqual([{ command: "notify" }, { command: core.quietHookCommand("stop") }]);
        expect(agent.hooks.agentSpawn[0].command).toMatch(/^\(export .*\) >\/dev\/null 2>&1$/);
        expect(cli("kiro").hookArgs).toEqual(["--agent", "polaris"]);
        expect(cli("kiro").launchArgs).toEqual(["chat"]);
        expect(cli("kiro").autonomyArgs).toEqual(["--trust-all-tools"]);
    });

    it("tool traffic and permission asks are work; only the stop is idle", () => {
        expect(at("kiro", "SessionStart")).toBe("active");
        expect(at("kiro", "PreToolUse")).toBe("active");
        expect(at("kiro", "Stop")).toBe("idle");
    });
});

describe("Cline", () => {
    it("one executable script per event that answers {\"cancel\": false} and nothing else", () => {
        const { home, workdir } = scratch();
        run(home, workdir, core.hookFileAnswers("cline"));
        const script = join(workdir, ".clinerules", "hooks", "PreToolUse");
        expect(readFileSync(script, "utf8")).toBe(core.hookRelayScript("permission-resolved", '{"cancel": false}'));
        const state = mkdtempSync(join(tmpdir(), "polaris-cline-state-"));
        writeFileSync(join(state, "hook.sh"), `#!/bin/sh\ncat > "$(dirname "$0")/got"; echo "$POLARIS_HOOK_EVENT" >> "$(dirname "$0")/got"; echo noise\n`, { mode: 0o755 });
        const done = spawnSync("sh", [script], { input: '{"taskId":"t"}', encoding: "utf8", env: { ...process.env, POLARIS_STATE_DIR: state } });
        expect(done.stdout).toBe('{"cancel": false}\n');
        expect(readFileSync(join(state, "got"), "utf8")).toBe('{"taskId":"t"}PermissionResolved\n');
        expect(at("cline", "PermissionResolved")).toBe("active");
        expect(at("cline", "Stop")).toBe("idle");
    });

    it("leaves a person's own script of the same name alone", () => {
        const { home, workdir } = scratch();
        mkdirSync(join(workdir, ".clinerules", "hooks"), { recursive: true });
        const file = join(workdir, ".clinerules", "hooks", "TaskStart");
        writeFileSync(file, "#!/bin/sh\necho mine\n");
        run(home, workdir, core.hookFileAnswers("cline"));
        expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");
    });
});

describe("memcode", () => {
    it("a flat hooks.json whose commands print nothing", () => {
        const [answer] = core.hookFileAnswers("memcode");
        expect(answer!.file).toBe("{workdir}/.memcode/hooks.json");
        expect(answer!.assert).toEqual({
            hooks: {
                session_start: [{ command: core.quietHookCommand("session-start"), timeout: 30 }],
                pre_tool_use: [{ command: core.quietHookCommand("pre-tool-use"), timeout: 30 }]
            }
        });
        const done = spawnSync("sh", ["-c", core.quietHookCommand("pre-tool-use")], { input: "{}", encoding: "utf8", env: { ...process.env, POLARIS_STATE_DIR: "" } });
        expect(done.stdout).toBe("");
        expect(at("memcode", "PreToolUse")).toBe("active");
        expect(at("memcode", "Stop")).toBeNull();
    });
});

describe("hook files of the session's own", () => {
    it("Muse: managed hooks naming this session's hook script, by its variable", () => {
        const config = sessionHookConfig("muse", "/session/polaris", { webhook: "" })!;
        expect(config.path).toBe("/session/polaris/muse-hooks.json");
        expect(config.env).toBe("TBH_MANAGED_HOOKS_PATH");
        const hooks = JSON.parse(config.contents).hooks;
        expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"]);
        expect(hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "POLARIS_HOOK_EVENT=Stop sh '/session/polaris/hook.sh'", timeout: 5 });
        expect(at("muse", "PermissionRequest")).toBe("blocked");
        expect(at("muse", "SessionStart")).toBeNull();
    });

    it("Codewhale: a lifecycle outbox posting to its own route", () => {
        const config = sessionHookConfig("codewhale", "/session/polaris", { webhook: "https://p.example/api/agents/sessions/s1/codewhale?token=t%22" })!;
        expect(config.env).toBe("CODEWHALE_MANAGED_CONFIG_PATH");
        expect(config.path).toBe("/session/polaris/codewhale-managed.toml");
        expect(config.contents).toContain('[lifecycle_outbox]\npath = "/session/polaris/codewhale-lifecycle.jsonl"\nwebhook_url = "https://p.example/api/agents/sessions/s1/codewhale?token=t%22"\n');
        for (const value of [config.path, config.env]) expect(core.hasControlCharacter(value)).toBe(false);
        expect(sessionHookConfig("claude", "/session/polaris", { webhook: "" })).toBeNull();
    });

    it("Codewhale deliveries: checked, then mapped as Agent Orchestrator maps them", () => {
        const delivery = (kind: string, extra: Record<string, unknown> = {}) =>
            codewhaleLifecycleSchema.safeParse({ at: "2026-11-15T10:00:00Z", event: { schema_version: 1, kind, thread_id: "sess_1", ...extra } });
        const ok = delivery("turn.started");
        expect(ok.success).toBe(true);
        expect(codewhaleHookPayload(ok.data!)).toEqual({ hook_event_name: "UserPromptSubmit", codewhale_kind: "turn.started" });
        expect(codewhaleSequence(ok.data!)).toBe(BigInt(Date.parse("2026-11-15T10:00:00Z")) * 1_000_000n);
        expect(codewhaleHookPayload(delivery("turn.failed").data!)!.hook_event_name).toBe("Stop");
        expect(codewhaleHookPayload(delivery("session.ended").data!)!.hook_event_name).toBe("SessionEnd");
        expect(codewhaleHookPayload(delivery("subagent.spawned").data!)).toBeNull();
        expect(delivery("turn.unknown").success).toBe(false);
        expect(delivery("turn.started", { schema_version: 2 }).success).toBe(false);
        expect(delivery("turn.started", { thread_id: "" }).success).toBe(false);
        expect(at("codewhale", "Stop")).toBe("waiting_input");
        expect(at("codewhale", "SessionEnd")).toBe("exited");
    });
});

describe("the launch", () => {
    it("adds the hook arguments unless the boot found the build refuses them", () => {
        expect(commands.LAUNCH_SCRIPT).toContain(
            `if [ -n "$POLARIS_AGENT_HOOK_ARGS" ] && [ ! -e "$POLARIS_STATE_DIR/${commands.HOOK_ARGS_REFUSED_FILE}" ]; then line="$line $POLARIS_AGENT_HOOK_ARGS"; fi`
        );
        for (const id of ["pi", "omp", "prime-agent"]) expect(cli(id).hookProbe, id).toBe("--extension");
        for (const entry of core.AGENT_CLIS)
            for (const arg of [...(entry.hookArgs ?? []), ...(entry.launchArgs ?? [])]) expect(arg).toMatch(/^[A-Za-z0-9=._/-]+$/);
    });

    it("the probe drops them for a build whose help does not list the flag, and keeps them on an unreadable help", () => {
        const setup = commands.SESSION_SETUP.split("\n");
        const from = setup.findIndex((line) => line.includes(`rm -f "$POLARIS_STATE_DIR/${commands.HOOK_ARGS_REFUSED_FILE}"`));
        const to = setup.indexOf("  unset help", from) + 1;
        const probe = setup.slice(from, to + 1).join("\n");
        const runProbe = (help: string): boolean => {
            const state = mkdtempSync(join(tmpdir(), "polaris-probe-"));
            const bin = join(state, "tool");
            writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${help}'\n`, { mode: 0o755 });
            const script = `as_agent() { sh -c "$1"; }\n${probe}`;
            spawnSync("sh", ["-c", script], {
                encoding: "utf8",
                env: { ...process.env, POLARIS_STATE_DIR: state, POLARIS_WORKDIR: state, POLARIS_AGENT_BINARY: bin, POLARIS_AGENT_HOOK_ARGS: "--extension x.ts", POLARIS_AGENT_HOOK_PROBE: "--extension" }
            });
            return spawnSync("test", ["-e", join(state, commands.HOOK_ARGS_REFUSED_FILE)]).status === 0;
        };
        if (process.platform === "win32") return;
        expect(runProbe("usage: tool [--model m]")).toBe(true);
        expect(runProbe("usage: tool [--extension path]")).toBe(false);
        expect(runProbe("")).toBe(false);
    });
});
