/**
 * The helper model as Polar's settings show it: Automatic when none is
 * picked, and a pick the person can no longer use reported as such.
 */

import { describe, expect, it } from "vitest";
import { helperAvailable, helperChoiceOf } from "@/components/polar/polar-helper-settings";

const PROVIDERS = [
    {
        provider: "openai",
        name: "OpenAI",
        payers: ["own" as const],
        models: [{ provider: "openai", model: "mini", name: "Mini", reasoning: false }]
    }
];

describe("helper model in settings", () => {
    it("is Automatic at the fastest level with no pick", () => {
        expect(helperChoiceOf(null)).toMatchObject({ provider: "auto", model: "auto" });
        expect(helperChoiceOf({ provider: "openai", model: "mini", payer: null })).toMatchObject({
            provider: "openai",
            model: "mini",
            intelligence: "fast"
        });
    });

    it("says whether a pick can still be used", () => {
        const pick = { provider: "openai", model: "mini", payer: null };
        expect(helperAvailable(null, PROVIDERS as never)).toBe(true);
        expect(helperAvailable(pick, null)).toBe(true);
        expect(helperAvailable(pick, PROVIDERS as never)).toBe(true);
        expect(helperAvailable({ ...pick, model: "gone" }, PROVIDERS as never)).toBe(false);
        expect(helperAvailable({ ...pick, provider: "anthropic" }, PROVIDERS as never)).toBe(false);
        expect(helperAvailable({ ...pick, payer: "instance" }, PROVIDERS as never)).toBe(false);
    });
});
