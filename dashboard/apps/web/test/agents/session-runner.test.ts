/**
 * A session that runs each prompt as a turn of its own, without the agent's
 * interface: the queue a prompt is written into, the scripts the boot writes,
 * and the hooks such a session registers.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "@polaris/core";
import * as commands from "@/lib/agents/session-commands";
import { claudeHookSettings } from "@/lib/agents/session-hooks";

const dirs: string[] = [];
function stateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "polaris-runner-")).replace(/\\/g, "/");
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs a command the way a session's machine does: `sh -s` with it on stdin. */
function run(command: string): number {
    return spawnSync("sh", ["-s"], { input: command, encoding: "utf8" }).status ?? -1;
}

describe("the prompt queue", () => {
    it("writes the prompt whole, as it was typed, for a session with a runner", () => {
        const dir = stateDir();
        writeFileSync(join(dir, commands.RUNNER_READY_FILE), "");
        const prompt = "Fix the form\n$(rm -rf /) `id` \"quoted\" 'single' \\ done";
        expect(run(commands.queuePromptCommand(dir, prompt))).toBe(0);
        const queued = readdirSync(join(dir, "prompts"));
        expect(queued).toHaveLength(1);
        expect(queued[0]).not.toMatch(/^\./);
        expect(readFileSync(join(dir, "prompts", queued[0]!), "utf8")).toBe(prompt);
    });

    it("leaves a session with no runner to its terminal", () => {
        const dir = stateDir();
        expect(run(commands.queuePromptCommand(dir, "Hola"))).toBe(commands.NOT_QUEUED.interactive);
    });

    it("keeps the prompts in the order they were sent", () => {
        const dir = stateDir();
        writeFileSync(join(dir, commands.RUNNER_READY_FILE), "");
        for (const text of ["one", "two", "three"]) run(commands.queuePromptCommand(dir, text));
        const names = readdirSync(join(dir, "prompts")).sort();
        expect(names.map((name) => readFileSync(join(dir, "prompts", name), "utf8"))).toEqual(["one", "two", "three"]);
    });
});

describe("the scripts a session boots with", () => {
    it("runs a turn on the conversation its hooks last named, with the prompt on standard input", () => {
        expect(commands.LAUNCH_SCRIPT).toContain('if [ -n "$turn" ]; then line="$line $POLARIS_AGENT_HEADLESS"; fi');
        expect(commands.LAUNCH_SCRIPT).toContain('line="$line < \\"$turn\\""');
        expect(commands.LAUNCH_SCRIPT).toContain('head -c 128 "$POLARIS_STATE_DIR/agent-session-id"');
    });

    it("says why a turn failed and when Polaris stopped one, so the session never stays on Working", () => {
        expect(commands.RUNNER_SCRIPT).toContain('"hook_event_name":"StopFailure"');
        expect(commands.RUNNER_SCRIPT).toContain('"hook_event_name":"Stop"');
        expect(commands.RUNNER_SCRIPT).toContain(commands.INTERFACE_WINDOW);
    });

    it("clears the boot's secrets again before the interface opens in a later window", () => {
        expect(commands.INTERFACE_SCRIPT).toMatch(/unset GIT_AUTH_HEADER POLARIS_HOOK_SCRIPT/);
        expect(commands.INTERFACE_SCRIPT).toContain('case "$id" in *[!A-Za-z0-9_-]*) id="" ;; esac');
    });

    it("never takes a runner's shell for an agent that exited", () => {
        expect(commands.agentExitedCommand(commands.TMUX_SESSION, "/s")).toMatch(/^! \[ -f "\/s\/runner\.ready" \] && /);
    });
});

describe("Claude Code without its interface", () => {
    it("runs a turn with -p, the flag its headless docs give", () => {
        expect(core.AGENT_CLIS.find((cli) => cli.id === "claude")?.headless).toEqual(["-p"]);
    });

    it("registers no SessionEnd, which every turn's process would send", () => {
        const hooks = claudeHookSettings("/s/hook.sh", { headless: true }).hooks as Record<string, unknown>;
        expect(hooks.SessionEnd).toBeUndefined();
        expect(hooks.Stop).toBeDefined();
        expect((claudeHookSettings("/s/hook.sh").hooks as Record<string, unknown>).SessionEnd).toBeDefined();
    });
});
