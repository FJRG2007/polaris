/**
 * A coding tool can run on an API key even when a subscription is linked.
 *
 * The picker used to list the subscriptions and nothing else once one existed,
 * so somebody signed in to Claude on a plan had no way to run Claude Code on
 * their Anthropic key. Each key is now a row of its own, and the session
 * started on one is handed that key alone.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/agents/model-keys", () => ({
    keySourcesFor: async () => new Map([["anthropic", "own"]]),
    signinAccountsFor: async () => new Map(),
    signinEnvsFor: async () => ["CLAUDE_CODE_OAUTH_TOKEN"],
    signinOptionsFor: async () => [
        { id: "sub-1", env: "CLAUDE_CODE_OAUTH_TOKEN", name: "Plan", identity: "me@example.test", source: "own" }
    ],
    apiKeyOptionsFor: async () => [
        { id: "key-1", env: "ANTHROPIC_API_KEY", name: "Work key", source: "own" }
    ]
}));

const { agentOptionsFor, sessionCredentials } = await import("@/lib/agents/agent-readiness");

describe("API keys in the agent picker", () => {
    it("lists the key beside the subscription", async () => {
        const claude = (await agentOptionsFor("u1")).filter((option) => option.cli === "claude");
        expect(claude.map((option) => [option.key, option.apiKey])).toEqual([
            [`claude:${core.MACHINE_LOGIN_KEY}`, false],
            ["claude:sub-1", false],
            ["claude:key-1", true]
        ]);
        const key = claude.find((option) => option.apiKey);
        expect(key).toMatchObject({ accountId: "key-1", account: "Work key", readiness: "ready", mine: true });
    });

    it("offers no key to a tool that does not read it", async () => {
        const codex = (await agentOptionsFor("u1")).filter((option) => option.cli === "codex");
        expect(codex.some((option) => option.apiKey)).toBe(false);
    });
});

describe("what a session started on a choice is handed", () => {
    const claude = core.agentCliById("claude")!;
    const available = { CLAUDE_CODE_OAUTH_TOKEN: "sub-token", ANTHROPIC_API_KEY: "sk-first" };

    it("is that key alone when an API key was picked", () => {
        const chosen = {
            env: "ANTHROPIC_API_KEY",
            secret: "sk-picked",
            apiKey: true,
            extra: { ANTHROPIC_CUSTOM_HEADERS: "anthropic-workspace-id: w1" }
        };
        expect(sessionCredentials(claude, available, chosen, false)).toEqual({
            ANTHROPIC_API_KEY: "sk-picked",
            ANTHROPIC_CUSTOM_HEADERS: "anthropic-workspace-id: w1"
        });
    });

    it("is the picked account over the rest for a subscription", () => {
        const chosen = { env: "CLAUDE_CODE_OAUTH_TOKEN", secret: "sub-picked", apiKey: false, extra: {} };
        expect(sessionCredentials(claude, available, chosen, false)).toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: "sub-picked",
            ANTHROPIC_API_KEY: "sk-first"
        });
    });

    it("is nothing for the machine's own login, and what resolves otherwise", () => {
        expect(sessionCredentials(claude, available, null, true)).toEqual({});
        expect(sessionCredentials(claude, available, null, false)).toEqual(available);
    });
});
