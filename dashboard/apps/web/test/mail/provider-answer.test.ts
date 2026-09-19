/**
 * What arrives back from the reputation provider, before any of it is believed.
 *
 * This is a third party's JSON reaching code that decides where somebody's mail
 * goes. The dangerous failure is not an error - an error is caught and the
 * message is delivered - it is an answer that is *almost* right: a missing
 * `allow` read as `undefined`, which is falsy, which is an accusation nobody
 * made. So the answer is validated against a schema and a shape that does not
 * match is not an answer at all.
 */

import { describe, expect, it, vi } from "vitest";

/** What the provider will answer with, for the case being run. */
let emailAnswer: unknown = { allow: true, reasons: [] };
let domainAnswer: unknown = { domain: { valid: true, fraud: false } };

vi.mock("dymo-api", () => ({
    default: class {
        public async isValidEmail(): Promise<unknown> {
            return emailAnswer;
        }
        public async isValidIP(): Promise<unknown> {
            return emailAnswer;
        }
        public async isValidDataRaw(): Promise<unknown> {
            return domainAnswer;
        }
    }
}));

const { verifyDomain, verifyEmail } = await import("@/lib/integrations/dymo");

describe("an answer about an address", () => {
    it("is read when it says what it is supposed to say", async () => {
        emailAnswer = { allow: false, reasons: ["FRAUD"] };
        expect(await verifyEmail("key", "someone@example.com")).toEqual({
            allow: false,
            reasons: ["FRAUD"]
        });
    });

    it("survives an answer with no reasons in it", async () => {
        emailAnswer = { allow: true };
        expect(await verifyEmail("key", "someone@example.com")).toEqual({
            allow: true,
            reasons: []
        });
    });

    it("refuses an answer that is missing the verdict rather than reading one", async () => {
        // The whole point. `undefined` is falsy, and a filter that read it as
        // "not allowed" would file somebody's mail on a parse error.
        emailAnswer = { reasons: ["FRAUD"] };
        await expect(verifyEmail("key", "someone@example.com")).rejects.toThrow();
    });

    it("refuses an answer that is not an object at all", async () => {
        emailAnswer = "rate limited";
        await expect(verifyEmail("key", "someone@example.com")).rejects.toThrow();
    });
});

describe("an answer about a domain", () => {
    it("reads the one flag it asked for", async () => {
        domainAnswer = { domain: { valid: true, fraud: true } };
        expect(await verifyDomain("key", "example.com")).toEqual({ fraud: true });
    });

    it("accuses nothing when the answer does not carry that flag", async () => {
        // Deliberately the permissive direction: the provider adds fields, and a
        // schema strict enough to reject an answer it has never seen would turn
        // every lookup into an accusation nobody can explain.
        domainAnswer = { domain: {} };
        expect(await verifyDomain("key", "example.com")).toEqual({ fraud: false });
        domainAnswer = {};
        expect(await verifyDomain("key", "example.com")).toEqual({ fraud: false });
    });

    it("refuses an answer that is not an object at all", async () => {
        domainAnswer = null;
        await expect(verifyDomain("key", "example.com")).rejects.toThrow();
    });
});
