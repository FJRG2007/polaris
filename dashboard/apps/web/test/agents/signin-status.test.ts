/**
 * Whether a home login is signed in.
 *
 * A false "Signed in" sends somebody to a session that stops at a login prompt,
 * so every reading here leans towards "signed out" or "unknown" when the tool's
 * answer is anything but a clean one.
 */

import { describe, expect, it } from "vitest";
import {
    cacheStatus,
    cachedStatus,
    lastKnownStatus,
    parseStatusLines,
    readStatusResult,
    recordSigninOutcome,
    STATUS_TTL_MS
} from "@/lib/agents/signin-status";
import { LOGIN_COMMANDS, signinStatusCommand, statusScript } from "@/lib/agents/signin-runtime";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("readStatusResult", () => {
    it("reads a clean exit as signed in", () => {
        expect(readStatusResult(0, "Logged in as someone@example.com")).toBe("in");
        expect(readStatusResult(0, "")).toBe("in");
    });

    it("reads a clean exit that says otherwise as signed out", () => {
        expect(readStatusResult(0, "Not logged in")).toBe("out");
        expect(readStatusResult(0, "You are not signed in.")).toBe("out");
        expect(readStatusResult(0, "status: unauthenticated")).toBe("out");
    });

    it("reads a failing exit as signed out, never signed in", () => {
        expect(readStatusResult(1, "Logged in as someone@example.com")).toBe("out");
        expect(readStatusResult(2, "")).toBe("out");
    });

    it("reads a tool that is not installed in the home as signed out", () => {
        expect(readStatusResult(127, "")).toBe("out");
    });

    it("reads a command that could not run as unknown", () => {
        expect(readStatusResult(null, "")).toBe("unknown");
        expect(readStatusResult(126, "")).toBe("unknown");
    });
});

describe("parseStatusLines", () => {
    it("reads one line per tool", () => {
        const output = [
            "some setup chatter",
            `polaris-status CURSOR_HOME_LOGIN 0 ${b64("Logged in as a@b.com")}`,
            `polaris-status KIRO_HOME_LOGIN 1 ${b64("Not logged in")}`,
            "polaris-status DEVIN_HOME_LOGIN 127 "
        ].join("\n");
        const found = parseStatusLines(output);
        expect(found.get("CURSOR_HOME_LOGIN")).toBe("in");
        expect(found.get("KIRO_HOME_LOGIN")).toBe("out");
        expect(found.get("DEVIN_HOME_LOGIN")).toBe("out");
    });

    it("skips a line that is not exactly the marker's shape", () => {
        const found = parseStatusLines(
            [
                "polaris-status lower_case 0",
                "polaris-status CURSOR_HOME_LOGIN abc",
                "polaris-status CURSOR_HOME_LOGIN 999",
                "polaris-status A B C D E",
                "xpolaris-status CURSOR_HOME_LOGIN 0"
            ].join("\n")
        );
        expect(found.size).toBe(0);
    });
});

describe("outcomes and the cache", () => {
    it("labels a recorded outcome as last known", () => {
        expect(lastKnownStatus("user-a", "AMP_HOME_LOGIN")).toEqual({ state: "unknown", lastKnown: false });
        recordSigninOutcome("user-a", "AMP_HOME_LOGIN", "login");
        expect(lastKnownStatus("user-a", "AMP_HOME_LOGIN")).toEqual({ state: "in", lastKnown: true });
        recordSigninOutcome("user-a", "AMP_HOME_LOGIN", "logout");
        expect(lastKnownStatus("user-a", "AMP_HOME_LOGIN")).toEqual({ state: "out", lastKnown: true });
        // Another person's record is theirs.
        expect(lastKnownStatus("user-b", "AMP_HOME_LOGIN").state).toBe("unknown");
    });

    it("reuses a checked answer inside the TTL and not after", () => {
        cacheStatus("user-c", "CURSOR_HOME_LOGIN", "in", 1_000);
        expect(cachedStatus("user-c", "CURSOR_HOME_LOGIN", 1_000 + STATUS_TTL_MS - 1)).toEqual({
            state: "in",
            lastKnown: false
        });
        expect(cachedStatus("user-c", "CURSOR_HOME_LOGIN", 1_000 + STATUS_TTL_MS)).toBeNull();
    });

    it("never caches an unknown, so a failed check is asked again", () => {
        cacheStatus("user-d", "CURSOR_HOME_LOGIN", "unknown", 1_000);
        expect(cachedStatus("user-d", "CURSOR_HOME_LOGIN", 1_001)).toBeNull();
    });

    it("drops the checked answer when a sign-in or sign-out finishes", () => {
        cacheStatus("user-e", "CURSOR_HOME_LOGIN", "in", Date.now());
        recordSigninOutcome("user-e", "CURSOR_HOME_LOGIN", "logout");
        expect(cachedStatus("user-e", "CURSOR_HOME_LOGIN", Date.now())).toBeNull();
    });
});

describe("status commands", () => {
    it("are only the documented ones, on home logins", () => {
        const withStatus = Object.entries(LOGIN_COMMANDS)
            .filter(([, login]) => login.status)
            .map(([env, login]) => [env, login.status]);
        expect(Object.fromEntries(withStatus)).toEqual({
            CURSOR_HOME_LOGIN: "cursor-agent status",
            KIRO_HOME_LOGIN: "kiro-cli whoami",
            DEVIN_HOME_LOGIN: "devin auth status"
        });
        for (const [env] of withStatus) expect(LOGIN_COMMANDS[env as string]?.home).toBe(true);
        expect(signinStatusCommand("AMP_HOME_LOGIN")).toBeNull();
        expect(signinStatusCommand("NOT_A_LOGIN")).toBeNull();
    });

    it("run as the agent and print one marker line each", () => {
        const script = statusScript([
            { env: "CURSOR_HOME_LOGIN", command: "cursor-agent status" },
            { env: "DEVIN_HOME_LOGIN", command: "devin auth status" }
        ]);
        expect(script).toContain("as_agent 'command -v cursor-agent'");
        expect(script).toContain("as_agent 'cursor-agent status'");
        expect(script).toContain("as_agent 'devin auth status'");
        expect(script).toContain("printf 'polaris-status %s %s %s\\n' 'CURSOR_HOME_LOGIN'");
        // The preamble's own output never reaches the parsed lines.
        expect(script.indexOf("} >/dev/null 2>&1")).toBeLessThan(script.indexOf("polaris-status"));
    });
});
