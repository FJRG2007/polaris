import { describe, expect, it } from "vitest";
import { normalizeSubject, rulesKey, REPUTATION_KINDS } from "@/lib/reputation";

/**
 * The two things that decide whether one cache is actually one cache.
 *
 * Every lookup Polaris makes to a reputation provider is billed, and the whole
 * reason this cache is keyed by the question rather than by who asked is so that
 * the firewall and the mail filter stop buying the same answers. That only works
 * if the same question written two ways lands on the same row - and the ways it
 * gets written differently are boring and constant: capital letters out of a
 * mail header, and the `+tag` somebody puts in an address.
 *
 * Get either wrong and nothing breaks visibly. The cache simply misses, the
 * provider is paid again, and the only symptom is a bill.
 */
describe("one question, one cached answer", () => {
    it("does not care how a subject was capitalised", () => {
        // Mail headers arrive in whatever case the sender's server felt like.
        expect(normalizeSubject("email", "Someone@Example.COM")).toBe("someone@example.com");
        expect(normalizeSubject("domain", "Example.COM")).toBe("example.com");
        expect(normalizeSubject("ip", " 203.0.113.7 ")).toBe("203.0.113.7");
    });

    it("treats an address and its tagged form as one address", () => {
        // `+news` is a label its owner chose, not a different mailbox. Asking
        // about both separately is paying twice for one answer.
        expect(normalizeSubject("email", "someone+news@example.com")).toBe("someone@example.com");
        expect(normalizeSubject("email", "someone+a+b@example.com")).toBe("someone@example.com");
    });

    it("leaves a plus alone where it is not a tag", () => {
        // A domain may not contain a `+` at all, and an address with one in the
        // domain half is not a tagged address.
        expect(normalizeSubject("domain", "a+b.example.com")).toBe("a+b.example.com");
        expect(normalizeSubject("email", "someone@ex+ample.com")).toBe("someone@ex+ample.com");
    });

    it("survives a value that is not one", () => {
        // Never throws: this sits in front of a paid lookup on a path that a
        // stranger's mail header can reach.
        for (const kind of REPUTATION_KINDS) {
            expect(() => normalizeSubject(kind, "")).not.toThrow();
            expect(() => normalizeSubject(kind, "@")).not.toThrow();
        }
        expect(normalizeSubject("email", "@example.com")).toBe("@example.com");
    });

    it("asks the same question however the conditions were written down", () => {
        // A verdict is only reused when it was reached under the same rules, so
        // the same set in a different order has to compare equal - otherwise
        // every lookup misses and the cache is decoration.
        expect(rulesKey(["FRAUD", "INVALID"])).toBe(rulesKey(["INVALID", "FRAUD"]));
        expect(rulesKey([" fraud ", "invalid"])).toBe(rulesKey(["FRAUD", "INVALID"]));
        expect(rulesKey([])).toBe("");
    });

    it("tells different conditions apart", () => {
        // The other half: a stricter question must not be answered from a
        // looser question's cache.
        expect(rulesKey(["FRAUD"])).not.toBe(rulesKey(["FRAUD", "HIGH_RISK_SCORE"]));
    });
});
