/**
 * The vendor login and logout commands Polaris runs for somebody.
 *
 * Every command here is one its vendor documents; a logout is never inferred
 * from a login, and a tool with no documented one has none. A login that writes
 * a file is only worth running if that file is the credential captured for the
 * next container, so every login without a token on its screen names a file.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import {
    LOGIN_COMMANDS,
    canAssistSignin,
    canSignout,
    signinCommand,
    signinCredentialFile,
    signinInstall
} from "@/lib/agents/signin-runtime";
import { hasScreenToken } from "@/lib/agents/signin-screen";

describe("sign-in commands", () => {
    it("captures something from every login", () => {
        for (const env of Object.keys(LOGIN_COMMANDS)) {
            const captured = hasScreenToken(env) || signinCredentialFile(env) !== null;
            expect(captured, env).toBe(true);
        }
    });

    it("keeps every logout to one line from the same tool", () => {
        for (const [env, login] of Object.entries(LOGIN_COMMANDS)) {
            if (!login.logout) continue;
            expect(login.logout, env).not.toMatch(/[\n\r]/);
            const cli = core.AGENT_CLIS.find((one) => one.id === login.cli);
            const binary = login.logout.replace(/^[A-Z_]+=\S+\s+/, "").split(" ")[0];
            expect(cli?.binaries, env).toContain(binary);
        }
    });

    it("signs Auggie in headless and keeps its session file", () => {
        expect(signinCommand("AUGGIE_ACCOUNT_AUTH", "login")).toBe("auggie auth login --headless");
        expect(signinCommand("AUGGIE_ACCOUNT_AUTH", "logout")).toBe("auggie auth logout");
        expect(signinCredentialFile("AUGGIE_ACCOUNT_AUTH")).toBe(".augment/session.json");
        expect(signinInstall("AUGGIE_ACCOUNT_AUTH")).toBe("npm install -g @augmentcode/auggie");
        expect(canAssistSignin("AUGGIE_ACCOUNT_AUTH")).toBe(true);
    });

    it("signs Codex out of the same file store it signed in to", () => {
        const logout = signinCommand("CODEX_CHATGPT_AUTH", "logout");
        expect(logout).toContain('cli_auth_credentials_store="file"');
        expect(logout).toMatch(/ logout$/);
    });

    it("offers no logout a vendor does not document", () => {
        expect(canSignout("CODEX_CHATGPT_AUTH")).toBe(true);
        expect(canSignout("AUGGIE_ACCOUNT_AUTH")).toBe(true);
        expect(canSignout("COPILOT_DEVICE_AUTH")).toBe(false);
        expect(canSignout("GEMINI_GOOGLE_AUTH")).toBe(false);
        expect(canSignout("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
        expect(signinCommand("GEMINI_API_KEY", "login")).toBeNull();
        expect(canSignout("GEMINI_API_KEY")).toBe(false);
    });
});
