/**
 * A repository's setup script, as the session's boot runs it.
 *
 * Exercised with a real shell against the fragment the boot is built from: it
 * runs once per checkout, without the clone credential, and a failure stops the
 * agent only where the repository asked for that.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as commands from "@/lib/agents/session-commands";

const posix = (path: string) => path.replace(/\\/g, "/");
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the fragment, then prints "agent" where the boot would start it. */
function boot(script: string, env: Record<string, string>): { output: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "polaris-setup-"));
    roots.push(root);
    const work = join(root, "repo");
    const state = join(root, "state");
    mkdirSync(work);
    mkdirSync(state);
    // From a file: a long script through `sh -c` fails on Windows.
    const file = join(root, "boot.sh");
    writeFileSync(
        file,
        [
            "set -e",
            'as_agent() { sh -c "$1"; }',
            ...commands.REPO_SETUP,
            'echo "agent started"',
            "echo agent-reached"
        ].join("\n")
    );
    const output = execFileSync("sh", [posix(file)], {
        encoding: "utf8",
        env: {
            ...process.env,
            POLARIS_WORKDIR: posix(work),
            POLARIS_STATE_DIR: posix(state),
            POLARIS_REPO_SETUP: Buffer.from(script, "utf8").toString("base64"),
            ...env
        },
        // `exec sh` reads this and ends at once.
        input: ""
    });
    return { output, root };
}

describe("repository setup script", () => {
    it("runs in the checkout before the agent, without the clone credential", () => {
        const { output, root } = boot('pwd; echo "header=${GIT_AUTH_HEADER:-none}"', {
            GIT_AUTH_HEADER: "Authorization: basic secret"
        });
        expect(output).toContain("/repo");
        expect(output).toContain("header=none");
        expect(output).toContain("the setup script finished");
        expect(output).toContain("agent-reached");
        expect(existsSync(join(root, "state", "setup-done"))).toBe(true);
    });

    it("starts the agent anyway when a setup that may fail fails", () => {
        const { output, root } = boot("exit 3", {});
        expect(output).toContain("The agent starts anyway");
        expect(output).toContain("agent-reached");
        expect(existsSync(join(root, "state", "setup-done"))).toBe(false);
    });

    it("stops before the agent when the repository requires the setup to pass", () => {
        const { output } = boot("exit 3", { POLARIS_REPO_SETUP_REQUIRED: "yes" });
        expect(output).toContain("The agent was not started");
        expect(output).not.toContain("agent-reached");
    });

    it("runs nothing when the repository has no setup script", () => {
        const { output } = boot("", { POLARIS_REPO_SETUP: "" });
        expect(output).not.toContain("setup script");
        expect(output).toContain("agent-reached");
    });

    it("is part of the boot, before the agent starts", () => {
        const setup = commands.SESSION_SETUP;
        expect(setup.indexOf(commands.REPO_SETUP[0])).toBeGreaterThan(-1);
        expect(setup.indexOf(commands.REPO_SETUP[0])).toBeLessThan(setup.indexOf("launch.sh"));
        expect(setup).toMatch(/unset [^\n]*POLARIS_REPO_SETUP/);
    });
});
