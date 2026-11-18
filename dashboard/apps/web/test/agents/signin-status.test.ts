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
import {
    LOGIN_COMMANDS,
    assistedSignins,
    homeSignins,
    isHomeSignin,
    signinCredentialFile,
    signinStatusCommand,
    statusScript
} from "@/lib/agents/signin-runtime";
import { agentSignins } from "@/lib/agents/agent-signins";

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

describe("more than one account per agent", () => {
    // Sourced in docs/agent-catalogue.md ("More than one account"). A home login
    // is marked single only where no variable, credential file or key lets a
    // second account sit beside it, or Polaris does not use the one documented.
    const SINGLE = ["AUTOHAND_HOME_LOGIN", "KIMI_HOME_LOGIN", "MIMO_HOME_LOGIN", "MINIMAX_HOME_LOGIN", "PI_HOME_LOGIN"];

    it("marks exactly the home logins that hold one account", () => {
        const single = Object.entries(LOGIN_COMMANDS)
            .filter(([, login]) => login.single)
            .map(([env]) => env)
            .sort();
        expect(single).toEqual(SINGLE);
        for (const env of single) expect(isHomeSignin(env)).toBe(true);
        const flagged = homeSignins().filter((signin) => signin.single).map((signin) => signin.env).sort();
        expect(flagged).toEqual(SINGLE);
    });

    it("keeps every existing home login, so an install's sign-in is still one row", () => {
        const homes = homeSignins().map((signin) => signin.env);
        for (const env of [
            "CURSOR_HOME_LOGIN",
            "KIRO_HOME_LOGIN",
            "GROK_HOME_LOGIN",
            "DEVIN_HOME_LOGIN",
            "AMP_HOME_LOGIN",
            "AUTOHAND_HOME_LOGIN",
            "FX_HOME_LOGIN",
            "MIMO_HOME_LOGIN",
            "MINIMAX_HOME_LOGIN",
            "KIMI_HOME_LOGIN",
            "PI_HOME_LOGIN",
            "DROID_HOME_LOGIN"
        ])
            expect(homes, env).toContain(env);
    });

    it("stores Devin accounts as rows, from the documented credentials file", () => {
        expect(isHomeSignin("DEVIN_ACCOUNT_AUTH")).toBe(false);
        expect(signinCredentialFile("DEVIN_ACCOUNT_AUTH")).toBe(".local/share/devin/credentials.toml");
        expect(LOGIN_COMMANDS.DEVIN_ACCOUNT_AUTH?.command).toBe(LOGIN_COMMANDS.DEVIN_HOME_LOGIN?.command);
        const stored = assistedSignins().find((signin) => signin.env === "DEVIN_ACCOUNT_AUTH");
        expect(stored?.home).toBeUndefined();
        expect(stored?.signout).toBe(true);
        expect(stored?.serves.map((tool) => tool.id)).toEqual(["devin"]);
    });

    it("signs the multi-account agents in with a stored row each", () => {
        // A key or token the tool reads from the environment: each stored row
        // is one account, and a session is handed the one it was started on.
        const stored = new Set(agentSignins().map((signin) => signin.env));
        for (const env of ["CURSOR_API_KEY", "KIRO_API_KEY", "AMP_API_KEY", "FACTORY_API_KEY", "DEVIN_ACCOUNT_AUTH"])
            expect(stored, env).toContain(env);
        // Served by the provider keys instead (xAI, Vercel AI Gateway), which
        // already hold as many as somebody adds.
        expect(stored.has("XAI_API_KEY")).toBe(false);
        expect(stored.has("AI_GATEWAY_API_KEY")).toBe(false);
    });
});
