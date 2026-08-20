/**
 * Where an account stands, and what moves it.
 *
 * The two things worth pinning: a suspension outranks the count - an account
 * shut for one thing bad enough is suspended, not "all good" - and the count
 * itself saturates rather than running off the end of the ladder, since there is
 * nothing past the last step but the suspension somebody decides on separately.
 */

import { describe, expect, it } from "vitest";
import { accountStanding, ACCOUNT_STANDINGS, standingIndex } from "../src/account-standing.js";

describe("account standing", () => {
    it("is all good until something is upheld", () => {
        expect(accountStanding({ suspended: false, upheld: 0 })).toBe("good");
    });

    it("climbs one step per upheld report", () => {
        expect(accountStanding({ suspended: false, upheld: 1 })).toBe("limited");
        expect(accountStanding({ suspended: false, upheld: 2 })).toBe("veryLimited");
        expect(accountStanding({ suspended: false, upheld: 3 })).toBe("atRisk");
    });

    it("stops at the last step rather than running past it", () => {
        expect(accountStanding({ suspended: false, upheld: 12 })).toBe("atRisk");
    });

    it("puts a suspension above the count, whatever the count says", () => {
        expect(accountStanding({ suspended: true, upheld: 0 })).toBe("suspended");
        expect(accountStanding({ suspended: true, upheld: 9 })).toBe("suspended");
    });

    it("orders the steps best first, which is the order they are drawn in", () => {
        expect(ACCOUNT_STANDINGS[0]).toBe("good");
        expect(standingIndex("good")).toBeLessThan(standingIndex("suspended"));
        expect(standingIndex("limited")).toBeLessThan(standingIndex("atRisk"));
    });
});
