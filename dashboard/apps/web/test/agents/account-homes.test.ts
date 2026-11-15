/**
 * Codex's per-account home: where it is, what the launch is told, and the
 * script that links everything but the sign-in back to the session's home and
 * only replaces the account's own sign-in when its owner linked it again.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import * as homes from "@/lib/agents/account-homes";

const ID = "00000000-0000-4000-8000-00000000000a";
const DIGEST = "a".repeat(64);

describe("account homes", () => {
    it("names a home per account for Codex and none for a tool that signs in by variable", () => {
        expect(homes.accountHomeFor("codex")?.env).toBe("CODEX_HOME");
        expect(homes.accountHomeFor("claude")).toBeNull();
        expect(homes.accountHomeEnvs()).toEqual(["CODEX_HOME"]);
        expect(homes.accountHomeDir("/home/node", "codex", ID)).toBe(`/home/node/.polaris-accounts/codex/${ID}`);
    });

    it("refuses an id, a home or a file name that could leave its directory", () => {
        expect(() => homes.accountHomeDir("/home/node", "codex", "../x")).toThrow();
        expect(() => homes.accountHomeDir("/home/node; rm -rf /", "codex", ID)).toThrow();
        expect(() => homes.accountHomeDir("/home/node", "claude", ID)).toThrow();
        const base = {
            cliId: "codex",
            userHome: "/home/node",
            accountId: ID,
            stateDir: "/session/polaris",
            digest: DIGEST
        };
        expect(() => homes.accountHomeCommand({ ...base, part: "../auth.json" })).toThrow();
        expect(() => homes.accountHomeCommand({ ...base, part: "account.abcdef12.part", digest: "$(id)" })).toThrow();
    });

    it("links the shared entries, keeps the sign-in private, and copies it only when new", () => {
        const script = homes.accountHomeCommand({
            cliId: "codex",
            userHome: "/home/node",
            accountId: ID,
            stateDir: "/session/polaris",
            part: "account.abcdef12.part",
            digest: DIGEST
        });
        expect(script).toContain(`a="/home/node/.polaris-accounts/codex/${ID}"`);
        expect(script).toContain("for n in sessions archived_sessions");
        expect(script).toContain("for n in config.toml history.jsonl");
        expect(script).toMatch(/case "\$n" in auth\.json\|models_cache\.json\|[^)]*\.polaris-stored\) continue/);
        expect(script).toContain('ln -s "$e" "$a/$n"');
        expect(script).toContain(`!= "${DIGEST}" ]; then`);
        expect(script).toContain('mv "$p" "$a/auth.json"');
        expect(script).toContain('chmod 0600 "$a/auth.json"');
        // Carries no credential: the file travels separately.
        expect(script).not.toMatch(/base64/);
    });

    it("digests the stored sign-in as hex, never the value", () => {
        const digest = homes.storedDigest(Buffer.from('{"tokens":{"refresh_token":"x"}}'));
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });
});

/** Git Bash makes a copy for `ln -s` unless told to make a real link. */
const SH_ENV = { ...process.env, MSYS: "winsymlinks:nativestrict" };

/** Whether sh is here and makes real symbolic links. */
function shLinks(): boolean {
    try {
        const dir = mkdtempSync(join(tmpdir(), "polaris-ln-"));
        execFileSync("sh", ["-c", 'cd "$1" && mkdir d && ln -s "$PWD/d" l && [ -L l ]', "sh", shPath(dir)], {
            stdio: "ignore",
            env: SH_ENV
        });
        return true;
    } catch {
        return false;
    }
}

/** A path sh can open on this machine: Git Bash takes `/c/...` for `C:\...`. */
function shPath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`);
}

describe.runIf(shLinks())("account home script on a real shell", () => {
    function prepare(home: string, stateDir: string, signin: string): void {
        const bytes = Buffer.from(signin);
        const part = "account.abcdef12.part";
        writeFileSync(join(stateDir, part), bytes);
        const script = homes.accountHomeCommand({
            cliId: "codex",
            userHome: shPath(home),
            accountId: ID,
            stateDir: shPath(stateDir),
            part,
            digest: homes.storedDigest(bytes)
        });
        execFileSync("sh", ["-c", script], { env: SH_ENV, stdio: "ignore" });
    }

    it("links the session's entries, keeps the sign-in private, and keeps the copy the tool refreshed", () => {
        const root = mkdtempSync(join(tmpdir(), "polaris-home-"));
        const home = join(root, "home");
        const stateDir = join(root, "state");
        mkdirSync(join(home, ".codex", "sessions", "2026"), { recursive: true });
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(home, ".codex", "auth.json"), "machine sign-in");
        writeFileSync(join(home, ".codex", "config.toml"), "model = \"x\"");
        prepare(home, stateDir, "first sign-in");

        const account = join(home, homes.ACCOUNTS_DIR, "codex", ID);
        for (const name of ["sessions", "config.toml", "history.jsonl", "logs"]) {
            expect(lstatSync(join(account, name)).isSymbolicLink()).toBe(true);
            expect(shPath(readlinkSync(join(account, name)))).toContain(`.codex/${name}`);
        }
        expect(lstatSync(join(account, "auth.json")).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(account, "auth.json"), "utf8")).toBe("first sign-in");
        if (process.platform !== "win32") expect(statSync(join(account, "auth.json")).mode & 0o777).toBe(0o600);
        expect(existsSync(join(stateDir, "account.abcdef12.part"))).toBe(false);

        // Codex refreshed its copy; the same stored sign-in does not overwrite it.
        writeFileSync(join(account, "auth.json"), "refreshed by codex");
        prepare(home, stateDir, "first sign-in");
        expect(readFileSync(join(account, "auth.json"), "utf8")).toBe("refreshed by codex");
        // Linked again by its owner: the new one goes in.
        prepare(home, stateDir, "linked again");
        expect(readFileSync(join(account, "auth.json"), "utf8")).toBe("linked again");
        // The session's own sign-in is never touched.
        expect(readFileSync(join(home, ".codex", "auth.json"), "utf8")).toBe("machine sign-in");
        // Three runs of a script that forks per entry: slow under Git Bash.
    }, 180_000);
});
