/**
 * What signs an agent in, and what Polaris is allowed to conclude from not
 * knowing.
 *
 * The three-way answer is the whole subject. A session that starts with nothing
 * in its environment does not fail: it comes up at the tool's own login prompt
 * inside a container nobody is watching, reports nothing, and is called failed
 * six hours later by the silence sweep. So the catalogue has to be able to say
 * "this one cannot sign in" before the button is pressed - and, just as
 * importantly, has to be able to say "I do not know" without that being read as
 * either answer.
 */

import { describe, expect, it } from "vitest";
import {
    AGENT_CLIS,
    agentCliById,
    agentReadiness,
    agentRunsUnattended,
    credentialInPlace,
    customAgentCli
} from "../src/agent-clis.js";

/** A machine holding exactly these variables. */
const holding =
    (...envs: string[]) =>
    (env: string): boolean =>
        envs.includes(env);

describe("agent credentials", () => {
    it("names a real environment variable for every credential it claims", () => {
        for (const cli of AGENT_CLIS) {
            for (const credential of cli.credentials) {
                // The tools read these by name. A lowercase one, or one with a
                // hyphen, is a variable no shell would ever set.
                expect(credential.env, cli.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
                expect(credential.label.length, cli.id).toBeGreaterThan(0);
                expect(credential.url, cli.id).toMatch(/^https:\/\//);
            }
        }
    });

    it("lists a vendor's subscription before its metered key", () => {
        // The order is what `credentialInPlace` returns from, so somebody holding
        // both is reported as running on the plan they already pay for.
        const claude = agentCliById("claude");
        expect(claude?.credentials[0]?.env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
        expect(claude?.credentials[0]?.subscription).toBe(true);
        expect(claude?.credentials[1]?.env).toBe("ANTHROPIC_API_KEY");
    });

    it("tells a subscription token from a key that starts a meter", () => {
        const claude = agentCliById("claude");
        const subscription = claude?.credentials.find((one) => one.subscription);
        // The one that needs an instruction rather than a link: it is minted by a
        // command, not copied off a page.
        expect(subscription?.howto).toBeTruthy();
    });
});

describe("credentialInPlace", () => {
    it("returns the first that answers, in the catalogue's order", () => {
        const claude = agentCliById("claude")!;
        expect(credentialInPlace(claude, holding("ANTHROPIC_API_KEY"))?.env).toBe("ANTHROPIC_API_KEY");
        expect(credentialInPlace(claude, holding("CLAUDE_CODE_OAUTH_TOKEN"))?.env).toBe(
            "CLAUDE_CODE_OAUTH_TOKEN"
        );
        expect(
            credentialInPlace(claude, holding("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"))?.env
        ).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("is null when nothing signs it in", () => {
        expect(credentialInPlace(agentCliById("claude")!, holding("OPENAI_API_KEY"))).toBeNull();
    });
});

describe("agentReadiness", () => {
    it("says ready when one of the tool's own variables is held", () => {
        expect(agentReadiness(agentCliById("codex")!, holding("OPENAI_API_KEY"))).toBe("ready");
    });

    it("says missing when none is", () => {
        expect(agentReadiness(agentCliById("codex")!, holding("ANTHROPIC_API_KEY"))).toBe("missing");
    });

    it("does not credit one tool's key to another", () => {
        // The failure this exists to stop: an account with an OpenAI key being
        // told Claude Code is ready, and finding out at the login prompt.
        expect(agentReadiness(agentCliById("claude")!, holding("OPENAI_API_KEY"))).toBe("missing");
    });

    it("says unknown, not missing, for a tool nothing was sourced for", () => {
        const unknown = AGENT_CLIS.filter((cli) => cli.credentials.length === 0);
        expect(unknown.length).toBeGreaterThan(0);
        for (const cli of unknown) {
            // Neither answer would be honest, and `missing` is the one that would
            // refuse to start a session for a reason nobody can check.
            expect(agentReadiness(cli, holding()), cli.id).toBe("unknown");
        }
    });

    it("says unknown for a command somebody typed", () => {
        expect(agentReadiness(customAgentCli("my-agent"), holding())).toBe("unknown");
    });

    it("counts a tool signed in by the session's own GitHub token as ready", () => {
        // Every session exports the installation token that checked the
        // repository out, so this one is signed in before anybody links anything.
        expect(agentReadiness(agentCliById("copilot")!, holding("GH_TOKEN"))).toBe("ready");
    });
});

describe("agentRunsUnattended", () => {
    it("lets a container work, because a container is a sandbox", () => {
        // A clone of one repository, no credential in it but the one that clone
        // needed, removed when the session ends. Refusing here would mean every
        // session waiting on a person who is not watching a container.
        expect(agentRunsUnattended("local", null)).toBe(true);
    });

    it("does not do the same on somebody's own server", () => {
        // The agent runs as the account Polaris enrolled, beside its SSH keys and
        // its Docker socket. Nobody chose that by picking a repository from a
        // list, so it is not chosen for them.
        expect(agentRunsUnattended("host", null)).toBe(false);
    });

    it("takes an answer over the default, in both directions", () => {
        expect(agentRunsUnattended("host", true)).toBe(true);
        expect(agentRunsUnattended("local", false)).toBe(false);
    });

    it("only ever applies flags a vendor documents for this", () => {
        // The flags are named "dangerously" by their vendors and that is the
        // point: they are only reachable through the decision above, never from
        // a tool being picked.
        const claude = agentCliById("claude")!;
        expect(claude.autonomyArgs).toContain("--dangerously-skip-permissions");
        const custom = customAgentCli("my-agent");
        // Nothing is known about a command somebody typed, so nothing is added
        // to it - whoever wrote it puts its flags in themselves.
        expect(custom.autonomyArgs).toEqual([]);
        expect(custom.autonomyEnv).toEqual({});
    });

    it("carries a flag or a variable for every tool, and never invents one", () => {
        for (const cli of AGENT_CLIS) {
            expect(Array.isArray(cli.autonomyArgs), cli.id).toBe(true);
            for (const arg of cli.autonomyArgs) expect(arg, cli.id).toMatch(/^--/);
            for (const value of Object.values(cli.autonomyEnv)) {
                expect(typeof value, cli.id).toBe("string");
            }
        }
    });
});
