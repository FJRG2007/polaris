/**
 * Which factors a sign-in owes, decided from the methods an account set up, the
 * ones it accepts, how strict it asked to be, and whether the sign-in comes from
 * a country it does not usually use. The rules that keep an owner from being
 * locked out are the ones most worth pinning down.
 */

import { describe, expect, it } from "vitest";
import * as policy from "@/lib/two-factor-policy";

describe("accepted methods", () => {
    it("accepts everything set up by default", () => {
        expect(policy.acceptedMethods(["totp", "email"], [])).toEqual(["totp", "email"]);
    });

    it("drops the refused ones", () => {
        expect(policy.acceptedMethods(["totp", "email"], ["totp"])).toEqual(["email"]);
    });

    it("never leaves nothing while something is set up", () => {
        expect(policy.acceptedMethods(["totp"], ["totp", "email"])).toEqual(["totp"]);
    });
});

describe("stored policy", () => {
    it("reads a missing row as the default", () => {
        expect(policy.parsePolicy(null)).toEqual(policy.DEFAULT_POLICY);
        expect(policy.DEFAULT_POLICY.strictness).toBe("unusual");
    });

    it("reads garbage as the default", () => {
        expect(policy.parsePolicy({ twoFactorRefused: "{nope", twoFactorStrictness: "max" })).toEqual(policy.DEFAULT_POLICY);
    });

    it("keeps a valid row", () => {
        // One unknown entry makes the stored list unreadable, which reads as none.
        expect(policy.parsePolicy({ twoFactorRefused: '["totp","sms"]', twoFactorStrictness: "all" })).toEqual({
            refused: [],
            strictness: "all"
        });
        expect(policy.parsePolicy({ twoFactorRefused: '["totp"]', twoFactorStrictness: "standard" })).toEqual({
            refused: ["totp"],
            strictness: "standard"
        });
    });
});

describe("usual country", () => {
    it("treats an unknown country as usual, so nobody is locked out without geolocation", () => {
        expect(policy.isUnusualCountry(null, ["ES"])).toBe(false);
        expect(policy.isUnusualCountry(undefined, ["ES"])).toBe(false);
    });

    it("treats anything as usual for an account with no history", () => {
        expect(policy.isUnusualCountry("US", [])).toBe(false);
    });

    it("flags a country outside the history", () => {
        expect(policy.isUnusualCountry("US", ["ES"])).toBe(true);
        expect(policy.isUnusualCountry("es", ["ES"])).toBe(false);
    });

    it("remembers the most recent first, bounded and deduplicated", () => {
        expect(policy.rememberCountry(["ES", "FR"], "fr")).toEqual(["FR", "ES"]);
        expect(policy.rememberCountry(["A1", "A2", "A3", "A4", "A5"], "ES")).toEqual(["ES", "A1", "A2", "A3", "A4"]);
        expect(policy.rememberCountry(["ES"], null)).toEqual(["ES"]);
    });
});

describe("required factors", () => {
    it("standard asks for one, wherever the sign-in is", () => {
        expect(policy.requiredFactors({ strictness: "standard", unusual: true, accepted: 3, hasQuestions: true })).toEqual({
            factors: 1,
            question: false
        });
    });

    it("unusual asks for two and the questions only from an unusual country", () => {
        expect(policy.requiredFactors({ strictness: "unusual", unusual: false, accepted: 3, hasQuestions: true })).toEqual({
            factors: 1,
            question: false
        });
        expect(policy.requiredFactors({ strictness: "unusual", unusual: true, accepted: 3, hasQuestions: true })).toEqual({
            factors: 2,
            question: true
        });
        expect(policy.requiredFactors({ strictness: "unusual", unusual: true, accepted: 3, hasQuestions: false })).toEqual({
            factors: 2,
            question: false
        });
    });

    it("all asks for every accepted method", () => {
        expect(policy.requiredFactors({ strictness: "all", unusual: false, accepted: 3, hasQuestions: true })).toEqual({
            factors: 3,
            question: false
        });
    });
});

describe("planning the extra step", () => {
    const usual = { factors: 1, question: false };

    it("leaves an account with no policy exactly as it was from its usual country", () => {
        const requirement = policy.requiredFactors({ ...policy.DEFAULT_POLICY, unusual: false, accepted: 2, hasQuestions: true });
        expect(policy.planStepUp({ factor: "totp", accepted: ["totp", "email"], requirement, reasonHint: null })).toBeNull();
        expect(policy.planStepUp({ factor: "trusted-device", accepted: ["totp"], requirement, reasonHint: null })).toBeNull();
    });

    it("never applies to a sign-in that answered no challenge", () => {
        expect(policy.planStepUp({ factor: null, accepted: ["totp"], requirement: { factors: 3, question: true }, reasonHint: null })).toBeNull();
    });

    it("lets a backup code through on its own", () => {
        const plan = policy.planStepUp({
            factor: "backup-code",
            accepted: ["totp", "email"],
            requirement: { factors: 2, question: true },
            reasonHint: "unusual-country"
        });
        expect(plan).toBeNull();
    });

    it("asks for a second method from an unusual country", () => {
        const plan = policy.planStepUp({
            factor: "totp",
            accepted: ["totp", "email", "whatsapp"],
            requirement: { factors: 2, question: false },
            reasonHint: "unusual-country"
        })!;
        expect(plan.reason).toBe("unusual-country");
        expect(policy.stepUpRemaining(plan)).toEqual({ factorsLeft: 1, methods: ["email", "whatsapp"], questionLeft: false });
        expect(policy.stepUpProgress(plan)).toEqual({ done: 1, total: 2 });
    });

    it("never asks for more methods than are set up", () => {
        const plan = policy.planStepUp({
            factor: "totp",
            accepted: ["totp"],
            requirement: { factors: 2, question: false },
            reasonHint: "unusual-country"
        });
        expect(plan).toBeNull();
    });

    it("still asks the questions when only one method exists", () => {
        const plan = policy.planStepUp({
            factor: "totp",
            accepted: ["totp"],
            requirement: { factors: 2, question: true },
            reasonHint: "unusual-country"
        })!;
        expect(policy.stepUpRemaining(plan)).toEqual({ factorsLeft: 0, methods: [], questionLeft: true });
        expect(policy.stepUpProgress(plan)).toEqual({ done: 1, total: 2 });
    });

    it("does not count a refused method", () => {
        const plan = policy.planStepUp({ factor: "totp", accepted: ["email"], requirement: usual, reasonHint: null })!;
        expect(plan.reason).toBe("not-accepted");
        expect(policy.stepUpRemaining(plan).methods).toEqual(["email"]);
    });

    it("asks for every method under all", () => {
        const plan = policy.planStepUp({
            factor: "email-code",
            accepted: ["totp", "email", "telegram"],
            requirement: { factors: 3, question: false },
            reasonHint: null
        })!;
        expect(plan.reason).toBe("all-methods");
        let state = policy.recordFactor(plan, "totp");
        expect(policy.stepUpComplete(state)).toBe(false);
        // Answering the same method twice is not two factors.
        expect(policy.recordFactor(state, "totp")).toBe(state);
        expect(policy.recordFactor(state, "email")).toBe(state);
        state = policy.recordFactor(state, "telegram");
        expect(policy.stepUpComplete(state)).toBe(true);
    });

    it("round-trips through storage and reads corruption as owing a step", () => {
        const plan = policy.planStepUp({
            factor: "totp",
            accepted: ["totp", "email"],
            requirement: { factors: 2, question: false },
            reasonHint: null
        })!;
        expect(policy.parseStepUp(policy.serializeStepUp(plan))).toEqual(plan);
        expect(policy.parseStepUp(null)).toBeNull();
        const corrupt = policy.parseStepUp("deciding")!;
        expect(policy.stepUpComplete(corrupt)).toBe(false);
        expect(policy.stepUpRemaining(corrupt).factorsLeft).toBe(1);
    });
});

describe("phone number check", () => {
    it("accepts the whole number, with or without the prefix and spacing", () => {
        expect(policy.phoneMatches("+34 600 11 12 22", "+34600111222")).toBe(true);
        expect(policy.phoneMatches("600111222", "+34600111222")).toBe(true);
    });

    it("refuses a wrong number, a short tail, and a longer one", () => {
        expect(policy.phoneMatches("600111223", "+34600111222")).toBe(false);
        expect(policy.phoneMatches("1222", "+34600111222")).toBe(false);
        expect(policy.phoneMatches("11222", "+34600111222")).toBe(false);
        expect(policy.phoneMatches("+3460011122299", "+34600111222")).toBe(false);
        expect(policy.phoneMatches("", "+34600111222")).toBe(false);
    });
});

describe("stricter", () => {
    it("is stricter when the level rises or a method is refused", () => {
        expect(policy.isStricter(policy.DEFAULT_POLICY, { refused: [], strictness: "all" })).toBe(true);
        expect(policy.isStricter(policy.DEFAULT_POLICY, { refused: ["totp"], strictness: "unusual" })).toBe(true);
        expect(policy.isStricter(policy.DEFAULT_POLICY, { refused: [], strictness: "standard" })).toBe(false);
    });
});
