/**
 * Whose account a linked credential turned out to be.
 *
 * This is what makes holding two of them possible. An account with a personal
 * subscription and a work one has two rows that are otherwise identical - same
 * variable, same label, same vendor - and no way to tell which is which, so
 * removing the wrong one is a coin flip and the list is unreadable.
 *
 * The answer comes from asking somebody else's program a question it was never
 * obliged to answer, so every failure here has to be an empty identity rather
 * than an exception or a guess: a credential nobody could identify still works,
 * and a wrong address on a row is worse than a blank one, because somebody would
 * delete the other row believing it.
 */

import { describe, expect, it } from "vitest";
import { parseSigninIdentity } from "@/lib/agents/signin-runtime";

describe("parseSigninIdentity", () => {
    it("reads the address the status command reported", () => {
        expect(parseSigninIdentity('{"email":"someone@example.com"}')).toEqual({
            email: "someone@example.com"
        });
    });

    it("finds it wherever that vendor happens to put it", () => {
        // These disagree about the key even between their own versions, so the
        // ones that have been seen are tried and nothing else is inferred.
        expect(parseSigninIdentity('{"emailAddress":"a@b.com"}').email).toBe("a@b.com");
        expect(parseSigninIdentity('{"account":{"email":"c@d.com"}}').email).toBe("c@d.com");
    });

    it("keeps the organisation when there is one", () => {
        const identity = parseSigninIdentity('{"email":"a@b.com","organizationName":"Acme"}');
        expect(identity).toEqual({ email: "a@b.com", organization: "Acme" });
    });

    it("says nothing rather than guessing, whatever it was handed", () => {
        // A version without the flag prints prose. Prose is not an identity, and
        // pulling a word out of it would put a wrong address on a row.
        expect(parseSigninIdentity("Logged in as someone@example.com")).toEqual({});
        expect(parseSigninIdentity("")).toEqual({});
        expect(parseSigninIdentity("null")).toEqual({});
        expect(parseSigninIdentity("[]")).toEqual({});
        expect(parseSigninIdentity('"a string"')).toEqual({});
    });

    it("ignores a field that is there but empty", () => {
        // An empty string is not an address, and storing one produces a row that
        // looks identified and is not.
        expect(parseSigninIdentity('{"email":"   ","organizationName":""}')).toEqual({});
    });

    it("ignores a field of the wrong type rather than rendering it", () => {
        expect(parseSigninIdentity('{"email":{"address":"a@b.com"}}')).toEqual({});
        expect(parseSigninIdentity('{"email":42}')).toEqual({});
    });
});
