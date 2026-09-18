/**
 * Telling one account from another, and keeping the list of them honest.
 *
 * The one that matters is the identity. Every other decision here - which account
 * a switch moves to, which row a park replaces, which token is spent - is made by
 * comparing ids, so an id that collides is two people's vaults treated as one and
 * an id that drifts is an account that cannot be switched back to.
 */

import { describe, expect, it } from "vitest";
import {
    accountHost,
    accountId,
    describeAccount,
    parkAccount,
    takeAccount,
    type ParkedAccount
} from "../src/lib/accounts";

/** An account, with only the fields a given test cares about spelled out. */
function account(fields: Partial<ParkedAccount> & { id: string }): ParkedAccount {
    return {
        origin: "https://polaris.example.com",
        email: null,
        name: null,
        refresh: "refresh-token",
        wrapped: null,
        accountKey: null,
        link: null,
        ...fields
    };
}

describe("what tells one account from another", () => {
    it("is the address and the person together", () => {
        const one = accountId("https://polaris.example.com", "ana@example.com");
        const two = accountId("https://polaris.example.com", "luis@example.com");
        expect(one).not.toBe(two);
    });

    it("counts the same person on two servers as two accounts", () => {
        expect(accountId("https://work.example.com", "ana@example.com")).not.toBe(
            accountId("https://home.example.com", "ana@example.com")
        );
    });

    it("does not make a second account out of a capital letter", () => {
        expect(accountId("HTTPS://Polaris.Example.com", "Ana@Example.com")).toBe(
            accountId("https://polaris.example.com", "ana@example.com")
        );
    });

    it("ignores space somebody typed around an address or an email", () => {
        expect(accountId("  https://polaris.example.com  ", " ana@example.com ")).toBe(
            accountId("https://polaris.example.com", "ana@example.com")
        );
    });

    it("cannot have one pair spelled as another", () => {
        // The separator is a newline because neither half can contain one. With an
        // ordinary character these two would be the same string.
        expect(accountId("https://a.example.com|b", null)).not.toBe(
            accountId("https://a.example.com", "b")
        );
    });

    it("identifies an account whose email has not arrived yet", () => {
        // A session opened by approval has no email until the first sync. It still
        // needs an id, or it could not be parked at all.
        expect(accountId("https://polaris.example.com", null)).toBe(
            accountId("https://polaris.example.com", "")
        );
    });
});

describe("setting an account aside", () => {
    it("keeps the ones already parked", () => {
        const parked = parkAccount([account({ id: "a" })], account({ id: "b" }));
        expect(parked.map((one) => one.id)).toEqual(["a", "b"]);
    });

    it("replaces the account rather than listing it twice", () => {
        // Switching away from an account and back to it parks it again. Appending
        // would leave two rows for one person, one of them holding a spent token.
        const parked = parkAccount(
            [account({ id: "a", refresh: "old" })],
            account({ id: "a", refresh: "new" })
        );
        expect(parked).toHaveLength(1);
        expect(parked[0]?.refresh).toBe("new");
    });

    it("starts a list from nothing", () => {
        expect(parkAccount([], account({ id: "a" })).map((one) => one.id)).toEqual(["a"]);
    });
});

describe("taking an account back out", () => {
    it("hands over the one asked for and what is left", () => {
        const move = takeAccount([account({ id: "a" }), account({ id: "b" })], "a");
        expect(move?.taken.id).toBe("a");
        expect(move?.rest.map((one) => one.id)).toEqual(["b"]);
    });

    it("says nothing when that account is not here", () => {
        // The popup can ask for an account that has since been signed out of in
        // another window. Null is what turns that into a sentence rather than a
        // switch into an account with no token.
        expect(takeAccount([account({ id: "a" })], "b")).toBeNull();
    });

    it("leaves the list alone", () => {
        const parked = [account({ id: "a" }), account({ id: "b" })];
        takeAccount(parked, "a");
        expect(parked).toHaveLength(2);
    });
});

describe("what an account is called on screen", () => {
    it("is the name when Polaris gave one", () => {
        expect(
            describeAccount({
                name: "Ana Ruiz",
                email: "ana@example.com",
                origin: "https://polaris.example.com"
            })
        ).toBe("Ana Ruiz");
    });

    it("falls back to the email when there is no name", () => {
        expect(
            describeAccount({
                name: null,
                email: "ana@example.com",
                origin: "https://polaris.example.com"
            })
        ).toBe("ana@example.com");
    });

    it("falls back to the address when there is neither", () => {
        // A Polaris too old to mint the account credential reaches here, and the
        // row still has to be one somebody can pick out of a list.
        expect(
            describeAccount({ name: null, email: null, origin: "https://polaris.example.com" })
        ).toBe("polaris.example.com");
    });

    it("treats a name of spaces as no name at all", () => {
        expect(
            describeAccount({
                name: "   ",
                email: "ana@example.com",
                origin: "https://polaris.example.com"
            })
        ).toBe("ana@example.com");
    });

    it("never comes back empty", () => {
        expect(describeAccount({ name: "", email: "", origin: "not an address" })).toBe(
            "not an address"
        );
    });
});

describe("the host of an address", () => {
    it("drops the scheme and the path", () => {
        expect(accountHost("https://polaris.example.com/vault")).toBe("polaris.example.com");
    });

    it("keeps a port, which is what tells two local servers apart", () => {
        expect(accountHost("http://localhost:3000")).toBe("localhost:3000");
    });

    it("shows an unparseable address as it stands", () => {
        expect(accountHost("not an address")).toBe("not an address");
    });
});
