/**
 * Where a run goes when its provider will not serve it.
 *
 * The rule that matters is that the repository's own model is never displaced.
 * Somebody picked it; a chain that could reorder that would make the setting
 * advisory, and the screen that shows it a lie.
 */

import { describe, expect, it } from "vitest";
import { AGENT_FALLBACK_MAX, failureIsWorthRetrying, resolveModelChain } from "./agents.js";

describe("resolveModelChain", () => {
    it("puts the chosen model first, whatever the chain says", () => {
        expect(resolveModelChain("groq/openai/gpt-oss-120b", ["anthropic/claude-opus"])).toEqual([
            "groq/openai/gpt-oss-120b",
            "anthropic/claude-opus"
        ]);
    });

    it("takes the most specific tier that said anything, not all of them", () => {
        // Same rule as every other setting here. Concatenating the tiers would
        // make one screen unreadable without opening the two above it.
        expect(resolveModelChain("a/1", ["b/2"], ["c/3"], ["d/4"])).toEqual(["a/1", "b/2"]);
    });

    it("falls past a tier that said nothing to one that did", () => {
        expect(resolveModelChain("a/1", null, ["c/3"])).toEqual(["a/1", "c/3"]);
    });

    it("treats an empty list as a deliberate nowhere, not as silence", () => {
        // The distinction the column keeps: null inherits, [] refuses to fall
        // back. A tier that meant the second must not get the third's answer.
        expect(resolveModelChain("a/1", [], ["c/3"])).toEqual(["a/1"]);
    });

    it("does not try the same model twice", () => {
        // A second runner spent learning what the first one already reported.
        expect(resolveModelChain("a/1", ["b/2", "a/1", "b/2"])).toEqual(["a/1", "b/2"]);
    });

    it("bounds the chain", () => {
        const long = Array.from({ length: 20 }, (_, index) => `p/${index}`);
        expect(resolveModelChain("a/1", long)).toHaveLength(AGENT_FALLBACK_MAX + 1);
    });

    it("ignores blank entries rather than dispatching to nothing", () => {
        expect(resolveModelChain("a/1", ["", "  ", "b/2"])).toEqual(["a/1", "b/2"]);
    });
});

describe("failureIsWorthRetrying", () => {
    it("retries the refusals that happened before any work", () => {
        // Nothing was written and nothing was pushed, so starting again
        // elsewhere costs a runner and repeats no side effect.
        for (const kind of [
            "rate-ceiling",
            "provider-billing",
            "router-billing",
            "api-key",
            "model-not-found",
            "no-provider",
            "context"
        ]) {
            expect(failureIsWorthRetrying(kind)).toBe(true);
        }
    });

    it("does not retry a failure that may have left commits behind", () => {
        // A hang is a failure AT the work. Re-running it on another model is a
        // guess that spends somebody's money to make it.
        expect(failureIsWorthRetrying("hang")).toBe(false);
        expect(failureIsWorthRetrying("unknown")).toBe(false);
    });

    it("does not retry a refusal by Polaris itself", () => {
        // No other model would be served either.
        expect(failureIsWorthRetrying("model-access")).toBe(false);
        expect(failureIsWorthRetrying("secrets-unavailable")).toBe(false);
    });

    it("does not retry a run that reported no kind at all", () => {
        expect(failureIsWorthRetrying(null)).toBe(false);
        expect(failureIsWorthRetrying(undefined)).toBe(false);
    });
});
