/**
 * What a session hands the agent, and what it must never hand it.
 *
 * This is the property the whole approach rests on: **Polaris does not sit
 * between the tool and the vendor.** The agent is the vendor's own binary,
 * talking to the vendor's own endpoint, signed in with the vendor's own
 * documented environment variable. Nothing here proxies it, rewrites a header,
 * or points it at a base URL of ours - so what the vendor sees is the tool being
 * used, which is what it is.
 *
 * That property is not enforced by anything at runtime. It holds because
 * `credentialsForAgent` narrows the stored secrets to the variables a tool's own
 * catalogue entry names, and because `secretForAccount` resolves an account's
 * provider through the same list. Both are one edit away from carrying something
 * else: the model-key store next door DOES hold `OPENAI_COMPATIBLE_BASE_URL`,
 * for runs, and the day that leaks into a session is the day every request from
 * it goes somewhere the person did not choose - through a machine that holds
 * their subscription.
 *
 * So it is pinned here. A new credential in the catalogue that is a URL, an
 * endpoint or a proxy fails this, and the failure is the conversation.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { credentialsForAgent } from "@/lib/agents/agent-readiness";

/**
 * Variable names that would move a request somewhere else.
 *
 * Matched on shape rather than listed exactly, because the list that matters is
 * the one nobody has written yet - a vendor adds `*_BASE_URL` next year and a
 * catalogue entry picks it up without anybody here noticing.
 */
const REDIRECTS = /(BASE_?URL|ENDPOINT|PROXY|HOST|GATEWAY|_URL)$/;

describe("what a session's environment may carry", () => {
    it("names no variable that could point a tool somewhere else", () => {
        for (const cli of core.AGENT_CLIS) {
            for (const credential of cli.credentials) {
                expect(credential.env, `${cli.id}: ${credential.env}`).not.toMatch(REDIRECTS);
            }
        }
    });

    it("carries only what the chosen tool's own entry asks for", () => {
        // The store is shared with runs, which hold things a session must never
        // see - a compatible-provider base URL among them. The narrowing is what
        // stops that, so it is asserted against a store that actually has one.
        const available: Record<string, string> = {
            CLAUDE_CODE_OAUTH_TOKEN: "sub-token",
            ANTHROPIC_API_KEY: "sk-ant",
            OPENAI_API_KEY: "sk-oai",
            OPENAI_COMPATIBLE_BASE_URL: "https://not-anthropic.example",
            OPENAI_COMPATIBLE_API_KEY: "sk-elsewhere",
            GH_TOKEN: "gh"
        };
        const claude = core.agentCliById("claude")!;
        const carried = credentialsForAgent(claude, available);

        expect(carried.CLAUDE_CODE_OAUTH_TOKEN).toBe("sub-token");
        expect(carried.ANTHROPIC_API_KEY).toBe("sk-ant");
        // Everything else in the store stayed in the store.
        expect(carried.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
        expect(carried.OPENAI_COMPATIBLE_API_KEY).toBeUndefined();
        expect(carried.OPENAI_API_KEY).toBeUndefined();
        expect(carried.GH_TOKEN).toBeUndefined();
    });

    it("carries nothing at all for a tool it holds nothing for", () => {
        // Not a guess, and not a refusal either: a machine with the tool already
        // signed in needs none of this, and inventing a variable name would be a
        // fact nobody can check.
        const claude = core.agentCliById("claude")!;
        expect(credentialsForAgent(claude, {})).toEqual({});
    });

    it("keeps the subscription first, so nobody is quietly put on a meter", () => {
        // Order is not cosmetic here. Most people running Claude Code are on a
        // plan they already pay for, and a screen that offered the API key first
        // would be asking them to pay twice for the same work.
        const claude = core.agentCliById("claude")!;
        expect(claude.credentials[0]?.env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
        expect(claude.credentials[0]?.subscription).toBe(true);
    });
});
