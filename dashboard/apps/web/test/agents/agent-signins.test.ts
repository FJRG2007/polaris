/**
 * Which credentials have nowhere else to live, and what they are stored under.
 *
 * The set is derived rather than listed - the catalogue says what each tool
 * reads, the model key store already answers for its own providers, and the
 * session already answers for GitHub - so the thing worth testing is the
 * subtraction. A provider added to the key store has to stop being asked for
 * here on the same commit, and a variable that IS asked for here has to be one
 * nothing else supplies.
 *
 * The slug is the other half. It goes into a column validated against a shape
 * that predates all of this, so a slug this module builds and the schema rejects
 * would be a credential nobody can ever store - and the first anybody would hear
 * of it is a form that will not submit.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { modelProviderSlugSchema } from "@polaris/core";
import { MODEL_PROVIDERS } from "@/lib/agents/agent-providers";
import {
    agentSignins,
    isSigninRow,
    isSigninSlug,
    signinEnv,
    signinLabel,
    signinSlug,
    SIGNIN_PREFIX
} from "@/lib/agents/agent-signins";

describe("agentSignins", () => {
    it("asks only for what nothing else supplies", () => {
        const served = new Set(MODEL_PROVIDERS.map((provider) => provider.envVar));
        for (const signin of agentSignins()) {
            expect(served.has(signin.env), signin.env).toBe(false);
            // The session exports this one itself, from the installation token
            // that checked the repository out.
            expect(signin.env).not.toBe("GH_TOKEN");
        }
    });

    it("includes the Claude subscription, which no provider serves", () => {
        const envs = agentSignins().map((signin) => signin.env);
        expect(envs).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("leaves out the Anthropic key, which the provider store already holds", () => {
        const envs = agentSignins().map((signin) => signin.env);
        expect(envs).not.toContain("ANTHROPIC_API_KEY");
        expect(envs).not.toContain("OPENAI_API_KEY");
    });

    it("names each variable once, whatever the tools do", () => {
        const envs = agentSignins().map((signin) => signin.env);
        expect(new Set(envs).size).toBe(envs.length);
    });

    it("says which tools each one signs in, with the id a mark is drawn from", () => {
        for (const signin of agentSignins()) {
            expect(signin.serves.length, signin.env).toBeGreaterThan(0);
            for (const tool of signin.serves) {
                expect(core.agentCliById(tool.id), tool.id).not.toBeNull();
            }
        }
    });
});

describe("signinSlug", () => {
    it("builds a slug the stored column will actually accept", () => {
        // The one that would otherwise fail silently: the variable's own name is
        // upper case with underscores, and the column takes neither.
        for (const signin of agentSignins()) {
            expect(modelProviderSlugSchema.safeParse(signin.slug).success, signin.slug).toBe(true);
        }
    });

    it("folds a variable to lower case and hyphens", () => {
        expect(signinSlug("CLAUDE_CODE_OAUTH_TOKEN")).toBe(`${SIGNIN_PREFIX}claude-code-oauth-token`);
    });

    it("cannot collide with a model provider", () => {
        const providers = new Set(MODEL_PROVIDERS.map((provider) => provider.slug));
        for (const signin of agentSignins()) {
            expect(providers.has(signin.slug), signin.slug).toBe(false);
            expect(signin.slug.startsWith(SIGNIN_PREFIX)).toBe(true);
        }
    });
});

describe("signinEnv", () => {
    it("gets back the variable a slug was built from", () => {
        for (const signin of agentSignins()) {
            expect(signinEnv(signin.slug)).toBe(signin.env);
        }
    });

    it("is null for a provider slug", () => {
        expect(signinEnv("anthropic")).toBeNull();
    });
});

describe("isSigninSlug and isSigninRow", () => {
    it("agree about a credential that is currently offered", () => {
        const one = agentSignins()[0]!;
        expect(isSigninSlug(one.slug)).toBe(true);
        expect(isSigninRow(one.slug)).toBe(true);
    });

    it("part ways over a row left behind by a tool that has gone", () => {
        const orphan = `${SIGNIN_PREFIX}some-departed-tool-key`;
        // Not offered any more, so nobody may store one...
        expect(isSigninSlug(orphan)).toBe(false);
        // ...but it is still a sign-in row, which is what keeps it off the
        // provider table rather than showing as a credential for a provider that
        // does not exist.
        expect(isSigninRow(orphan)).toBe(true);
    });

    it("says no to a model provider either way", () => {
        expect(isSigninSlug("anthropic")).toBe(false);
        expect(isSigninRow("anthropic")).toBe(false);
    });
});

describe("signinLabel", () => {
    it("is the vendor's own words for the credential", () => {
        const one = agentSignins().find((signin) => signin.env === "CLAUDE_CODE_OAUTH_TOKEN")!;
        expect(signinLabel(one.slug)).toBe(one.label);
    });

    it("falls back to the slug rather than inventing a name", () => {
        expect(signinLabel(`${SIGNIN_PREFIX}gone`)).toBe(`${SIGNIN_PREFIX}gone`);
    });
});
