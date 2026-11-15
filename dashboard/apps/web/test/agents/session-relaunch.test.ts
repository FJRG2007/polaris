/**
 * Restarting an agent in its own interface on the account its session moved
 * to: the turn ends with Esc before the pane restarts, on the same
 * conversation, and the restarted agent starts with the boot's secrets
 * cleared, leaving a shell in the terminal and closing the interface window.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as commands from "@/lib/agents/session-commands";

const ID = "019a7b2c-1d2e-7f30-8a41-b5c6d7e8f901";

describe("relaunchAgentCommand", () => {
    it("ends the turn with Esc, clears the ready flag, then restarts the pane on the conversation", () => {
        const script = commands.relaunchAgentCommand("/session/polaris", ID);
        const esc = script.indexOf("send-keys -t \"$t\" Escape");
        const settle = script.indexOf(`sleep ${commands.RELAUNCH_SETTLE_SECONDS}`);
        const flag = script.indexOf("rm -f ");
        const respawn = script.indexOf("respawn-pane -k");
        expect(esc).toBeGreaterThan(0);
        expect(settle).toBeGreaterThan(esc);
        expect(flag).toBeGreaterThan(settle);
        expect(respawn).toBeGreaterThan(flag);
        expect(script).toContain(`relaunch.sh\\" ${ID} $m"`);
        expect(script).toContain(`exit ${commands.NOT_RELAUNCHED.nextTurn}`);
        expect(script).toContain(`:${commands.INTERFACE_WINDOW}'; m=window`);
    });

    it("refuses a conversation id that could be a command", () => {
        expect(() => commands.relaunchAgentCommand("/session/polaris", "x; rm -rf /")).toThrow();
    });

    it("waits on the interface window when it is open, else on the terminal", () => {
        const ready = commands.relaunchedReadyCommand();
        expect(ready).toContain(`${commands.TMUX_SESSION}:${commands.INTERFACE_WINDOW}`);
        expect(ready.startsWith("if ")).toBe(true);
    });
});

function hasSh(): boolean {
    try {
        execFileSync("sh", ["-c", "command -v base64"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/** A path sh can open on this machine: Git Bash takes `/c/...` for `C:\...`. */
function shPath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`);
}

describe.runIf(hasSh())("the relaunch script on a real shell", () => {
    function relaunch(mode: string, id: string): string {
        const dir = mkdtempSync(join(tmpdir(), "polaris-relaunch-"));
        writeFileSync(join(dir, "relaunch.sh"), commands.RELAUNCH_SCRIPT);
        writeFileSync(join(dir, "launch.sh"), 'echo "launch [$1] secret=[${GIT_AUTH_HEADER:-}] key=[${OPENAI_API_KEY:-}]"\n');
        return execFileSync("sh", [`${shPath(dir)}/relaunch.sh`, id, mode], {
            encoding: "utf8",
            input: "echo shell-after\n",
            env: {
                ...process.env,
                POLARIS_STATE_DIR: shPath(dir),
                GIT_AUTH_HEADER: "boot-secret",
                OPENAI_API_KEY: "boot-key",
                POLARIS_CREDENTIAL_FILES: "OPENAI_API_KEY=x"
            }
        });
    }

    it("starts the agent on the conversation without the boot's secrets and leaves a shell in the terminal", () => {
        const output = relaunch("terminal", ID);
        expect(output).toContain(`launch [${ID}] secret=[] key=[]`);
        expect(output).toContain("polaris: the agent exited.");
        expect(output).toContain("shell-after");
    });

    it("closes the interface window with the agent, and drops an id that is not one", () => {
        const output = relaunch("window", "bad;id");
        expect(output).toContain("launch [] secret=[]");
        expect(output).not.toContain("shell-after");
    });
});
