/**
 * The terminal's side of a session started again on a new machine: the
 * conversation id it stopped in is seeded where the hooks keep it and the
 * agent is launched on it (`claude --resume <id>`, `codex resume <id>`); a tool
 * that refuses it (its transcript is not in this home) is started once more on
 * a new conversation, with one line saying so. Run in a real shell.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as commands from "@/lib/agents/session-commands";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

const posix = (path: string) => path.replace(/\\/g, "/");

/** Both blocks against a stand-in launch.sh that logs its argument and exits
 *  with `code` when handed a conversation id. */
function boot(env: Record<string, string>, code = 0) {
    const state = mkdtempSync(join(tmpdir(), "polaris-reopen-"));
    const launch = join(state, "launch.sh");
    writeFileSync(
        launch,
        `echo "launch [$1]" >> "$POLARIS_STATE_DIR/calls"\nif [ -n "$1" ]; then exit ${code}; fi\n`
    );
    chmodSync(launch, 0o755);
    const script = [...commands.SEED_RESUME_ID, ...commands.LAUNCH_AGENT].join("\n");
    const result = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, POLARIS_STATE_DIR: posix(state), POLARIS_REOPENED: "", ...env }
    });
    const calls = existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8").trim().split("\n") : [];
    const seeded = existsSync(join(state, "agent-session-id"))
        ? readFileSync(join(state, "agent-session-id"), "utf8")
        : null;
    return { stdout: result.stdout, calls, seeded };
}

describe("a reopened session's launch", () => {
    it("launches the agent on the conversation it stopped in", () => {
        const run = boot({ POLARIS_AGENT_RESUME_ID: "3f2a-conv_01" });
        expect(run.calls).toEqual(["launch [3f2a-conv_01]"]);
        expect(run.seeded).toBe("3f2a-conv_01");
    });

    it("starts a new conversation, once, when the tool refuses the old one", () => {
        const run = boot({ POLARIS_AGENT_RESUME_ID: "3f2a-conv_01" }, 1);
        expect(run.calls).toEqual(["launch [3f2a-conv_01]", "launch []"]);
        expect(run.stdout).toContain("could not reopen its conversation here");
        // Not handed to the next relaunch either.
        expect(run.seeded).toBeNull();
    });

    it("seeds nothing it would have to quote", () => {
        const run = boot({ POLARIS_AGENT_RESUME_ID: "id; rm -rf /" });
        expect(run.seeded).toBeNull();
        expect(run.calls).toEqual(["launch []"]);
    });

    it("launches a new conversation when there is nothing to reopen", () => {
        const run = boot({ POLARIS_AGENT_RESUME_ID: "" });
        expect(run.calls).toEqual(["launch []"]);
    });

    it("leaves a machine that restarted under the session on the id its hooks wrote", () => {
        const state = boot({ POLARIS_AGENT_RESUME_ID: "", POLARIS_REOPENED: "yes" });
        // No id kept on this machine: launched on a new one, no retry line.
        expect(state.calls).toEqual(["launch []"]);
        expect(state.stdout).not.toContain("could not reopen");
    });
});
