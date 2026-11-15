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
    assistedSignins,
    canAssistSignin,
    canSignout,
    homeSignins,
    isHomeSignin,
    signinCommand,
    signinCredentialFile,
    signinInstall
} from "@/lib/agents/signin-runtime";
import { agentSignins } from "@/lib/agents/agent-signins";
import { hasScreenToken, screenShowsAny } from "@/lib/agents/signin-screen";

describe("sign-in commands", () => {
    it("captures something from every login that is stored", () => {
        for (const env of Object.keys(LOGIN_COMMANDS)) {
            if (isHomeSignin(env)) continue;
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

    it("runs every login with the binary of the tool it names", () => {
        for (const [env, login] of Object.entries(LOGIN_COMMANDS)) {
            const cli = core.AGENT_CLIS.find((one) => one.id === login.cli);
            const binary = login.command.replace(/^[A-Z_]+=\S+\s+/, "").split(" ")[0];
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

    it("lists a login kept in the home as one, and never as something to store", () => {
        const home = homeSignins();
        expect(home.map((one) => one.env)).toEqual(
            Object.keys(LOGIN_COMMANDS).filter((env) => isHomeSignin(env))
        );
        const storable = new Set(agentSignins().map((one) => one.env));
        for (const signin of home) {
            expect(signin.home, signin.env).toBe(true);
            expect(signin.file, signin.env).toBeNull();
            expect(storable.has(signin.env), signin.env).toBe(false);
            expect(canAssistSignin(signin.env), signin.env).toBe(true);
        }
        expect(assistedSignins().filter((one) => one.home)).toHaveLength(home.length);
    });

    it("signs Cursor in without opening a browser, and Kiro with no logout", () => {
        expect(signinCommand("CURSOR_HOME_LOGIN", "login")).toBe("NO_OPEN_BROWSER=1 cursor-agent login");
        expect(signinCommand("CURSOR_HOME_LOGIN", "logout")).toBe("cursor-agent logout");
        expect(LOGIN_COMMANDS.CURSOR_HOME_LOGIN?.flow).toBe("open");
        expect(signinCommand("KIRO_HOME_LOGIN", "login")).toBe("kiro-cli login");
        expect(canSignout("KIRO_HOME_LOGIN")).toBe(false);
        expect(homeSignins().find((one) => one.env === "CURSOR_HOME_LOGIN")?.signout).toBe(true);
    });

    it("types an in-tool login only once a ready marker is on the screen", () => {
        const kimi = LOGIN_COMMANDS.KIMI_HOME_LOGIN?.input;
        expect(kimi?.text).toBe("/login");
        expect(screenShowsAny("Welcome Run /login or /provider to get started.", kimi?.after ?? [])).toBe(true);
        expect(screenShowsAny("Installing...", kimi?.after ?? [])).toBe(false);
        // Droid has no known marker: never typed on a guess, offered as a button.
        expect(LOGIN_COMMANDS.DROID_HOME_LOGIN?.input?.after).toBeUndefined();
        expect(screenShowsAny("anything", [])).toBe(false);
        expect(screenShowsAny("anything", [""])).toBe(false);
    });
});
