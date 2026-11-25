/**
 * Who a session's agent commits as: the identity resolved from the person's
 * linked GitHub account (or their Polaris account), the boot lines that write
 * it, and the GitHub CLI and push credentials beside it - with no token ever
 * printed. The shell is run for real (Git Bash's `sh` on Windows).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findUnique: vi.fn() }));
const links = vi.hoisted(() => ({ list: vi.fn(), credentials: vi.fn(), read: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: { user: { findUnique: db.findUnique } } }));
vi.mock("@/lib/connections/store", () => ({ listConnections: links.list }));
vi.mock("@/lib/github-access", () => ({ githubCredentialsForUser: links.credentials }));
vi.mock("@/lib/github-service", () => ({ readGithubAccount: links.read }));

import * as commands from "@/lib/agents/session-commands";
import { GH_WRAPPER_SCRIPT } from "@/lib/agents/session-gh";
import * as identity from "@/lib/agents/session-git-identity";
import { gitIdentityFor } from "@/lib/agents/session-git-identity-source";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
    db.findUnique.mockReset();
    links.list.mockReset();
    links.credentials.mockReset();
    links.read.mockReset();
});

const posix = (path: string) => path.replace(/\\/g, "/");

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "polaris-git-id-"));
    dirs.push(dir);
    return dir;
}

describe("the identity a GitHub account commits as", () => {
    it("uses the display name and the noreply address when no address is public", () => {
        expect(identity.identityFromGithub({ id: 4242, login: "octo-cat", name: "Octo Cat", email: null })).toEqual({
            name: "Octo Cat",
            email: "4242+octo-cat@users.noreply.github.com"
        });
    });

    it("falls back to the login and keeps an address the person published", () => {
        expect(identity.identityFromGithub({ id: "7", login: "octo", email: " Octo@Example.test " })).toEqual({
            name: "octo",
            email: "octo@example.test"
        });
    });

    it("refuses fields GitHub never gives, and keeps a name on one line", () => {
        expect(identity.identityFromGithub({ id: "abc", login: "octo" })).toBeNull();
        expect(identity.identityFromGithub({ id: 1, login: "bad login" })).toBeNull();
        expect(identity.identityFromGithub({ id: 1, login: "octo", name: "A\nB <x>" })?.name).toBe("A B x");
    });

    it("uses the Polaris account when there is no GitHub one", () => {
        expect(identity.identityFromUser({ name: "Ada", email: "ADA@example.test" })).toEqual({
            name: "Ada",
            email: "ada@example.test"
        });
        expect(identity.identityFromUser({ name: "Ada", email: "not an address" })).toBeNull();
    });
});

describe("resolving the identity for a session", () => {
    const link = (id: string, label: string, accountId: string, method = "oauth") => ({ id, label, accountId, method });

    it("prefers the account linked for the repository's owner, read live", async () => {
        links.list.mockResolvedValue([link("c1", "personal", "1"), link("c2", "acme", "2")]);
        links.credentials.mockResolvedValue([{ connectionId: "c2", login: "acme", method: "oauth", token: "ghu_x" }]);
        links.read.mockResolvedValue({ id: 2, login: "acme", name: "Acme Dev", email: null, avatarUrl: null });
        expect(await gitIdentityFor("u1", "Acme/site")).toEqual({
            name: "Acme Dev",
            email: "2+acme@users.noreply.github.com"
        });
        expect(links.read).toHaveBeenCalledWith("ghu_x");
    });

    it("settles for the stored connection when GitHub cannot be reached", async () => {
        links.list.mockResolvedValue([link("c1", "octo", "99")]);
        links.credentials.mockResolvedValue([{ connectionId: "c1", login: "octo", method: "oauth", token: "t" }]);
        links.read.mockRejectedValue(new Error("offline"));
        expect(await gitIdentityFor("u1", "other/repo")).toEqual({
            name: "octo",
            email: "99+octo@users.noreply.github.com"
        });
    });

    it("falls back to the Polaris account without a GitHub link, and names nobody without an owner", async () => {
        links.list.mockResolvedValue([link("m", "typed", "", "manual")]);
        links.credentials.mockResolvedValue([]);
        db.findUnique.mockResolvedValue({ name: "Ada", email: "ada@example.test" });
        expect(await gitIdentityFor("u1", "")).toEqual({ name: "Ada", email: "ada@example.test" });
        expect(await gitIdentityFor(null, "a/b")).toBeNull();
    });
});

describe("the boot", () => {
    it("sets the identity after the checkout and before the agent, with gh and the push helper", () => {
        const setup = commands.SESSION_SETUP;
        const at = (line: string) => setup.indexOf(line);
        expect(at(identity.SET_GIT_IDENTITY[1])).toBeGreaterThan(at("git config credential.https://github.com.username x-access-token"));
        expect(at(identity.SET_GIT_IDENTITY[1])).toBeLessThan(at('if [ -n "$GITHUB_REPOSITORY" ] && [ -f "$POLARIS_STATE_DIR/git-credential.sh" ]; then'));
        expect(setup).toContain('git config --global user.email "$POLARIS_GIT_EMAIL"');
        expect(setup).toContain('git config credential.https://github.com.helper "!sh \\"$POLARIS_STATE_DIR/git-credential.sh\\""');
        expect(setup).toContain('printf "%s\\n" "$gh_real" > "$POLARIS_STATE_DIR/gh-path"');
    });

    it("never prints a token", () => {
        const scripts = [commands.SESSION_SETUP, commands.LAUNCH_SCRIPT, GH_WRAPPER_SCRIPT];
        for (const script of scripts) {
            for (const line of script.split("\n")) {
                if (!/\b(echo|printf)\b/.test(line)) continue;
                expect(line).not.toMatch(/\$\{?(GH_TOKEN|GITHUB_TOKEN|token|GIT_AUTH_HEADER)\b/);
                // The credential helper arrives encoded and is only ever decoded into its file.
                if (line.includes("$POLARIS_GIT_CREDENTIAL")) expect(line).toMatch(/base64 -d > "\$POLARIS_STATE_DIR\/git-credential\.sh"$/);
            }
        }
    });

    it("tells the agent git and gh are set up only when they are", () => {
        expect(commands.LAUNCH_SCRIPT).toContain(`if [ -f "${identity.GIT_IDENTITY_MARK}" ]; then`);
        expect(commands.LAUNCH_SCRIPT).toContain('if [ -x "$POLARIS_STATE_DIR/bin/gh" ]; then');
        for (const prompt of [identity.GIT_PROMPT, identity.GH_PROMPT]) expect(prompt).not.toMatch(/["$`\\]/);
    });

    function boot(scope: string, env: Record<string, string>) {
        const dir = scratch();
        const home = join(dir, "home");
        const repo = join(dir, "repo");
        const state = join(dir, "state");
        for (const path of [home, state]) spawnSync("mkdir", ["-p", posix(path)], { windowsHide: true });
        spawnSync("git", ["init", "-q", posix(repo)], { windowsHide: true });
        const script = ["set -e", "POLARIS_AS_ROOT=no", `cd "${posix(repo)}"`, ...identity.SET_GIT_IDENTITY].join("\n");
        const result = spawnSync("sh", [], {
            input: script,
            encoding: "utf8",
            env: {
                ...process.env,
                HOME: posix(home),
                XDG_CONFIG_HOME: posix(join(home, ".config")),
                GIT_CONFIG_NOSYSTEM: "1",
                POLARIS_HOME: posix(home),
                GITHUB_REPOSITORY: "acme/site",
                POLARIS_STATE_DIR: posix(state),
                POLARIS_GIT_NAME: "Acme Dev",
                POLARIS_GIT_EMAIL: "2+acme@users.noreply.github.com",
                POLARIS_GIT_SCOPE: scope,
                ...env
            }
        });
        const read = (args: string[]) =>
            spawnSync("git", ["-C", posix(repo), ...args], { encoding: "utf8", env: { ...process.env, HOME: posix(home), XDG_CONFIG_HOME: posix(join(home, ".config")), GIT_CONFIG_NOSYSTEM: "1" } }).stdout.trim();
        return { result, home, state, read };
    }

    it("writes the home's config where the home is the person's own", () => {
        const run = boot("global", {});
        expect(run.result.stderr).toBe("");
        expect(run.result.status).toBe(0);
        expect(run.read(["config", "--global", "user.email"])).toBe("2+acme@users.noreply.github.com");
        expect(run.read(["config", "--global", "user.name"])).toBe("Acme Dev");
        expect(existsSync(join(run.state, "git-identity"))).toBe(true);
    });

    it("writes only the checkout in a shared home", () => {
        const run = boot("repo", {});
        expect(run.result.status).toBe(0);
        expect(run.read(["config", "--global", "user.email"])).toBe("");
        expect(run.read(["config", "--local", "user.email"])).toBe("2+acme@users.noreply.github.com");
    });

    it("leaves a server's own identity standing", () => {
        const run = boot("missing", {});
        expect(run.read(["config", "--local", "user.email"])).toBe("2+acme@users.noreply.github.com");
        const own = boot("missing", {});
        writeFileSync(join(own.home, ".gitconfig"), "[user]\n\tname = Owner\n\temail = owner@example.test\n");
        const again = spawnSync("sh", [], {
            input: ["set -e", "POLARIS_AS_ROOT=no", ...identity.SET_GIT_IDENTITY].join("\n"),
            encoding: "utf8",
            cwd: own.home,
            env: { ...process.env, HOME: posix(own.home), XDG_CONFIG_HOME: posix(join(own.home, ".config")), GIT_CONFIG_NOSYSTEM: "1", GITHUB_REPOSITORY: "", POLARIS_HOME: "", POLARIS_STATE_DIR: posix(own.state), POLARIS_GIT_NAME: "X", POLARIS_GIT_EMAIL: "x@example.test", POLARIS_GIT_SCOPE: "missing" }
        });
        expect(again.status).toBe(0);
        expect(own.read(["config", "--global", "user.email"])).toBe("owner@example.test");
        expect(existsSync(join(own.state, "git-identity"))).toBe(true);
    });

    it("sets nothing, and leaves no mark, when Polaris knows nobody", () => {
        const run = boot("global", { POLARIS_GIT_NAME: "", POLARIS_GIT_EMAIL: "" });
        expect(run.result.status).toBe(0);
        expect(run.read(["config", "--global", "user.email"])).toBe("");
        expect(existsSync(join(run.state, "git-identity"))).toBe(false);
    });
});
