/**
 * A session's agent reads its credentials as they are now, not as they were
 * when its machine booted, and a refused sign-in is recognised.
 *
 * Seen on 2026-11-13: a session booted before the plan-over-key fix kept sending
 * the stored API key on every turn (a workspace 400), and the stored Claude
 * sign-in itself answered "401 Invalid bearer token" - which the session showed
 * as a bare failed turn, with nothing saying to link the account again.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as commands from "@/lib/agents/session-commands";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { isSignInRefusal, lastTurnRefused } from "@/lib/agents/signin-refusal";

/** Whether a POSIX shell is here to run the scripts for real. */
function shell(): boolean {
    try {
        execFileSync("sh", ["-c", "true"]);
        return true;
    } catch {
        return false;
    }
}

describe("the credentials file", () => {
    it("clears every variable the tool reads before setting the current ones", () => {
        const body = commands.credentialsFileBody(
            ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
            { CLAUDE_CODE_OAUTH_TOKEN: "tok'en" }
        );
        expect(body).toContain("unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN");
        expect(body).toContain("export CLAUDE_CODE_OAUTH_TOKEN");
        expect(body).not.toMatch(/^ANTHROPIC_API_KEY=/m);
    });

    it("refuses a name that is not a variable and a value with a control character", () => {
        expect(() => commands.credentialsFileBody(["BAD NAME"], {})).toThrow(/BAD NAME/);
        expect(() => commands.credentialsFileBody([], { TOKEN: "a\nb" })).toThrow(/TOKEN/);
        expect(() => commands.credentialsFileBody([], { TOKEN: "a\nb" })).not.toThrow(/a\nb/);
    });

    it("installs only a file Polaris named", () => {
        expect(() => commands.installCredentialsCommand("/s", "../../etc/passwd")).toThrow();
        expect(() => commands.installCredentialsCommand("/s", "credentials.0123abcd.part")).not.toThrow();
    });

    it.runIf(shell())("drops a stale key a session booted with, and teaches an old launch script", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-creds-"));
        const launch = join(dir, "launch.sh");
        // A launch script from before this, which knows nothing about the file.
        writeFileSync(launch, '#!/bin/sh\nenv | grep -E "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=" | sort\n');
        const body = commands.credentialsFileBody(
            ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
            { CLAUDE_CODE_OAUTH_TOKEN: "fresh" }
        );
        execFileSync("sh", ["-c", commands.writeCredentialsCommand(dir, "credentials.0123abcd.part", body)]);
        expect(existsSync(join(dir, "credentials.0123abcd.part"))).toBe(false);
        expect(readFileSync(launch, "utf8")).toContain(commands.CREDENTIALS_FILE);
        const said = execFileSync("sh", [launch], {
            env: {
                PATH: process.env.PATH ?? "",
                POLARIS_STATE_DIR: dir,
                ANTHROPIC_API_KEY: "stale",
                CLAUDE_CODE_OAUTH_TOKEN: "old"
            }
        }).toString();
        expect(said.trim()).toBe("CLAUDE_CODE_OAUTH_TOKEN=fresh");
    });

    it.runIf(shell())("writes nothing for a session that has no launch script yet", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-creds-"));
        execFileSync("sh", ["-c", commands.writeCredentialsCommand(dir, "credentials.0123abcd.part", "x=1\n")]);
        expect(existsSync(join(dir, commands.CREDENTIALS_FILE))).toBe(false);
    });

    it("is read by the launch script before anything else", () => {
        const lines = commands.LAUNCH_SCRIPT.split("\n");
        expect(lines.findIndex((line) => line.includes(commands.CREDENTIALS_FILE))).toBeLessThan(5);
    });
});

describe("a refused sign-in", () => {
    it("is what the tools say when the credential is not accepted", () => {
        expect(isSignInRefusal("Failed to authenticate. API Error: 401 Invalid bearer token")).toBe(true);
        expect(isSignInRefusal("authentication_failed")).toBe(true);
        expect(isSignInRefusal("OAuth token has expired")).toBe(true);
        expect(isSignInRefusal("invalid x-api-key")).toBe(true);
    });

    it("is not any failure that happens to mention 401", () => {
        expect(isSignInRefusal("Error at line 401 of build.ts")).toBe(false);
        expect(
            isSignInRefusal("API Error: 400 This API key is not scoped to a workspace")
        ).toBe(false);
        expect(isSignInRefusal("")).toBe(false);
        expect(isSignInRefusal(null)).toBe(false);
    });

    it("is cleared by a later turn that worked", () => {
        const refused = { kind: "turn.failed", detail: "API Error: 401 Invalid bearer token" };
        expect(lastTurnRefused([{ kind: "prompt", detail: "hi" }, refused])).toBe(true);
        expect(lastTurnRefused([refused, { kind: "turn.end", detail: "" }])).toBe(false);
        expect(lastTurnRefused([{ kind: "turn.failed", detail: "rate limited" }])).toBe(false);
    });
});
