/**
 * The GitHub CLI inside a session: installed pinned and checked, run through a
 * wrapper that mints its token per run, and the model a session switched to read
 * by the launch script. The shell is run for real (Git Bash's `sh` on Windows).
 */

import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as gh from "@/lib/agents/session-gh";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as commands from "@/lib/agents/session-commands";
import { gitCredentialScript } from "@/lib/agents/session-hooks";
import { AGENT_GH_PERMISSIONS } from "@/lib/github-installation-scope";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posix = (path: string) => path.replace(/\\/g, "/");

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "polaris-gh-"));
    dirs.push(dir);
    return dir;
}

function tool(dir: string, name: string, body: string): void {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
}

function run(script: string, env: Record<string, string>, args: string[] = ["-s"]) {
    return spawnSync("sh", args, { input: script, encoding: "utf8", env: { ...process.env, ...env } });
}

describe("the helper's token for gh", () => {
    it("asks for the gh scope and prints only the token", () => {
        const dir = scratch();
        tool(dir, "curl", 'case "$*" in *tool=gh*) printf "username=x-access-token\\npassword=ghs_gh\\n" ;; esac');
        const helper = join(dir, "helper.sh");
        writeFileSync(helper, gitCredentialScript("https://polaris.example.test/api/agents/sessions/s1/git-credential", "tok-1"));
        const result = spawnSync("sh", [posix(helper), "token"], {
            encoding: "utf8",
            env: { ...process.env, PATH: `${posix(dir)}:${process.env.PATH}` }
        });
        expect(result.stdout).toBe("ghs_gh\n");
    });

    it("mints issues and pull requests on top of contents", () => {
        expect(AGENT_GH_PERMISSIONS).toMatchObject({ contents: "write", issues: "write", pull_requests: "write" });
    });
});

describe("the gh wrapper", () => {
    function state(helperBody: string) {
        const dir = scratch();
        mkdirSync(join(dir, "bin"));
        writeFileSync(join(dir, "bin", "gh"), gh.GH_WRAPPER_SCRIPT);
        chmodSync(join(dir, "bin", "gh"), 0o755);
        tool(dir, "real-gh", 'printf "%s|%s\\n" "${GH_TOKEN:-none}" "$*"');
        writeFileSync(join(dir, "gh-path"), `${posix(join(dir, "real-gh"))}\n`);
        writeFileSync(join(dir, "git-credential.sh"), `#!/bin/sh\n${helperBody}\n`);
        return dir;
    }

    it("runs the real gh with the session's token and the same arguments", () => {
        const dir = state('[ "$1" = "token" ] && echo ghs_scoped');
        const result = spawnSync("sh", [posix(join(dir, "bin", "gh")), "issue", "list"], { encoding: "utf8" });
        expect(result.stdout).toBe("ghs_scoped|issue list\n");
    });

    it("keeps the token it already had when no token was minted", () => {
        const dir = state("exit 0");
        const result = spawnSync("sh", [posix(join(dir, "bin", "gh")), "repo", "view"], {
            encoding: "utf8",
            env: { ...process.env, GH_TOKEN: "own" }
        });
        expect(result.stdout).toBe("own|repo view\n");
    });

    it("says so when there is no gh behind it", () => {
        const dir = state("exit 0");
        writeFileSync(join(dir, "gh-path"), "/nowhere/gh\n");
        const result = spawnSync("sh", [posix(join(dir, "bin", "gh"))], { encoding: "utf8" });
        expect(result.status).toBe(127);
        expect(result.stderr).toContain("not installed");
    });
});

describe("installing the pinned release", () => {
    it("refuses a download that does not match the checksum and installs nothing", () => {
        const home = scratch();
        const bin = scratch();
        tool(bin, "curl", 'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { echo tampered > "$2"; }; shift; done');
        tool(bin, "uname", "echo x86_64");
        const result = run(gh.GH_INSTALL_SCRIPT, { HOME: posix(home), PATH: `${posix(bin)}:${process.env.PATH}` });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain("did not match its checksum");
        expect(existsSync(join(home, ".polaris", "tools", `gh-${gh.GH_VERSION}`))).toBe(false);
    });

    it("does nothing when the pinned release is already there", () => {
        const home = scratch();
        const bin = join(home, ".polaris", "tools", `gh-${gh.GH_VERSION}`, "bin");
        mkdirSync(bin, { recursive: true });
        tool(bin, "gh", "exit 0");
        const result = run(gh.GH_INSTALL_SCRIPT, { HOME: posix(home) });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
    });
});

/** This machine's PATH without a GitHub CLI installer's own directory, and
 *  whether a gh is still found on it (a CI runner image carries one). */
const noGhPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !/github cli/i.test(entry))
    .join(delimiter);
const machineHasGh =
    spawnSync("sh", ["-c", "command -v gh"], { encoding: "utf8", env: { ...process.env, PATH: noGhPath } }).status === 0;

describe("the boot's gh lines", () => {
    const boot = (env: Record<string, string>) =>
        run(['as_agent() { sh -c "$1"; }', "POLARIS_AS_ROOT=no", ...gh.INSTALL_GH].join("\n"), env);

    it("puts the wrapper in front of a gh the machine already has", () => {
        const stateDir = scratch();
        const bin = scratch();
        tool(bin, "gh", "exit 0");
        writeFileSync(join(stateDir, "git-credential.sh"), "#!/bin/sh\n");
        const result = boot({
            GITHUB_REPOSITORY: "acme/app",
            POLARIS_STATE_DIR: posix(stateDir),
            PATH: `${posix(bin)}:${process.env.PATH}`
        });
        expect(result.status).toBe(0);
        expect(readFileSync(join(stateDir, "bin", "gh"), "utf8")).toBe(gh.GH_WRAPPER_SCRIPT);
        const real = readFileSync(join(stateDir, "gh-path"), "utf8").trim();
        expect(real.endsWith("/gh")).toBe(true);
        expect(run(`[ -x "${real}" ]`, {}).status).toBe(0);
    });

    it.skipIf(machineHasGh)("uses the pinned release in the kept home when the machine has none", () => {
        const stateDir = scratch();
        const home = scratch();
        const release = join(home, ".polaris", "tools", `gh-${gh.GH_VERSION}`, "bin");
        mkdirSync(release, { recursive: true });
        tool(release, "gh", "exit 0");
        writeFileSync(join(stateDir, "git-credential.sh"), "#!/bin/sh\n");
        const result = boot({ GITHUB_REPOSITORY: "acme/app", POLARIS_STATE_DIR: posix(stateDir), HOME: posix(home), PATH: noGhPath });
        expect(result.status).toBe(0);
        const real = readFileSync(join(stateDir, "gh-path"), "utf8").trim();
        expect(real.endsWith(`/.polaris/tools/gh-${gh.GH_VERSION}/bin/gh`)).toBe(true);
    });

    it("does nothing for a workspace with no repository", () => {
        const stateDir = scratch();
        const result = boot({ GITHUB_REPOSITORY: "", POLARIS_STATE_DIR: posix(stateDir) });
        expect(result.status).toBe(0);
        expect(existsSync(join(stateDir, "bin"))).toBe(false);
    });

    it("runs after the credential helper is written and before the agent starts", () => {
        const setup = commands.SESSION_SETUP;
        expect(setup.indexOf("polaris-gh.XXXXXX")).toBeGreaterThan(setup.indexOf("git-credential.sh"));
        expect(setup).not.toContain("GH_TOKEN");
        expect(commands.LAUNCH_SCRIPT).toContain('PATH="$POLARIS_STATE_DIR/bin:$PATH"');
    });
});

describe("the launch script and a model changed mid-session", () => {
    function launch(model: string | null): string {
        const dir = scratch();
        if (model !== null) writeFileSync(join(dir, "model"), model);
        writeFileSync(join(dir, "launch.sh"), commands.LAUNCH_SCRIPT);
        const result = spawnSync("sh", [posix(join(dir, "launch.sh"))], {
            encoding: "utf8",
            env: {
                ...process.env,
                TMPDIR: posix(dir),
                POLARIS_STATE_DIR: posix(dir),
                POLARIS_WORKDIR: posix(dir),
                POLARIS_AGENT_COMMAND: "echo",
                POLARIS_AGENT_BINARY: "echo",
                POLARIS_AGENT_CONFIG: "claude",
                POLARIS_AGENT_LAUNCHER: "",
                POLARIS_AS_ROOT: "no"
            }
        });
        return result.stdout;
    }

    it("passes the model last, quoted", () => {
        expect(launch("sonnet[1m]")).toContain("--model sonnet[1m] --settings");
    });

    it("drops a model id that is not one", () => {
        expect(launch("x;touch pwned")).not.toContain("--model");
        expect(launch(null)).not.toContain("--model");
    });
});
