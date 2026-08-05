import { describe, expect, it } from "vitest";
import { formatScope, orgScope, parseScope, personalScope, sameScope, scopeOrgId, PERSONAL_SCOPE } from "../src/scope";

describe("workspace scope", () => {
    it("round-trips both kinds", () => {
        expect(parseScope(formatScope(personalScope))).toEqual(personalScope);
        expect(parseScope(formatScope(orgScope("abc")))).toEqual(orgScope("abc"));
        expect(formatScope(orgScope("abc"))).toBe("org:abc");
        expect(formatScope(personalScope)).toBe(PERSONAL_SCOPE);
    });

    it("falls back to the personal shelf for anything it cannot read", () => {
        // The value arrives from a cookie, so every one of these is something a
        // browser can present, and none of them may resolve to an organization.
        for (const raw of [null, undefined, "", "   ", "org:", "org", "team:1", "personal"]) {
            expect(parseScope(raw)).toEqual(personalScope);
        }
    });

    it("names the organization a query should filter on", () => {
        expect(scopeOrgId(personalScope)).toBeNull();
        expect(scopeOrgId(orgScope("acme"))).toBe("acme");
    });

    it("compares by what is stored, not by identity", () => {
        expect(sameScope(orgScope("a"), orgScope("a"))).toBe(true);
        expect(sameScope(orgScope("a"), orgScope("b"))).toBe(false);
        expect(sameScope(personalScope, orgScope("a"))).toBe(false);
    });
});
