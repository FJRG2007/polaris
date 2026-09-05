/**
 * Reading a payment card.
 *
 * The numbers below are the networks' own published test numbers - they pass the
 * check digit and belong to nobody - which is the only kind of card number that
 * belongs in a repository.
 *
 * What is pinned hardest is when NOT to complain. A card number is wrong for
 * almost all of the time somebody is typing it, and a form that says so at digit
 * four is a form shouting at somebody halfway through a word; the complaint has
 * to wait until the number is long enough to actually be judged.
 */

import * as cards from "./vault-cards.js";
import { describe, expect, it } from "vitest";

/** Published test numbers. Every one of them passes Luhn and none of them is an
 *  account. */
const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const MASTERCARD_2SERIES = "2223003122003222";
const AMEX = "378282246310005";
const DISCOVER = "6011111111111117";
const DINERS = "36227206271667";
const JCB = "3530111333300000";
const UNIONPAY = "6250947000000014";

describe("which brand a number belongs to", () => {
    it("is named from the opening digits", () => {
        expect(cards.cardBrand(VISA)).toBe("Visa");
        expect(cards.cardBrand(MASTERCARD)).toBe("Mastercard");
        expect(cards.cardBrand(MASTERCARD_2SERIES)).toBe("Mastercard");
        expect(cards.cardBrand(AMEX)).toBe("Amex");
        expect(cards.cardBrand(DISCOVER)).toBe("Discover");
        expect(cards.cardBrand(DINERS)).toBe("Diners Club");
        expect(cards.cardBrand(JCB)).toBe("JCB");
        expect(cards.cardBrand(UNIONPAY)).toBe("UnionPay");
    });

    it("is named from the first digits alone, while it is still being typed", () => {
        // The whole point of showing the mark: it appears as somebody types
        // rather than once they have finished.
        expect(cards.cardBrand("41")).toBe("Visa");
        expect(cards.cardBrand("5412")).toBe("Mastercard");
    });

    it("is nothing while there is not enough to tell", () => {
        expect(cards.cardBrand("")).toBeNull();
        expect(cards.cardBrand("4")).toBeNull();
        expect(cards.cardBrand("99")).toBeNull();
    });

    it("reads a number written in the groups it is printed in", () => {
        expect(cards.cardBrand("4111 1111 1111 1111")).toBe("Visa");
    });
});

describe("the check digit", () => {
    it("accepts the numbers the networks publish", () => {
        for (const number of [VISA, MASTERCARD, AMEX, DISCOVER, DINERS, JCB, UNIONPAY]) {
            expect(cards.luhnValid(number)).toBe(true);
        }
    });

    it("catches one mistyped digit", () => {
        expect(cards.luhnValid("4111111111111112")).toBe(false);
    });

    it("catches two digits swapped over", () => {
        // Which, with a single typo, is nearly every way a number gets copied
        // wrong.
        expect(cards.luhnValid("5555555555544454")).toBe(false);
    });
});

describe("what the form says while it is being typed", () => {
    it("says nothing about a number that is not finished", () => {
        expect(cards.cardNumberProblem("")).toBeNull();
        expect(cards.cardNumberProblem("4111")).toBeNull();
        expect(cards.cardNumberProblem("41111111")).toBeNull();
    });

    it("says nothing about a number that adds up", () => {
        expect(cards.cardNumberProblem(VISA)).toBeNull();
        expect(cards.cardNumberProblem(AMEX)).toBeNull();
    });

    it("says so once the digits do not add up", () => {
        expect(cards.cardNumberProblem("4111111111111112")).toBeTruthy();
    });

    it("says so when there are more digits than a card has", () => {
        expect(cards.cardNumberProblem(`${VISA}0000`)).toBeTruthy();
    });
});

describe("the number as it is printed", () => {
    it("goes in fours", () => {
        expect(cards.groupCardNumber(VISA)).toBe("4111 1111 1111 1111");
    });

    it("goes 4-6-5 for Amex, which is how Amex prints it", () => {
        expect(cards.groupCardNumber(AMEX)).toBe("3782 822463 10005");
    });
});

describe("the expiry, typed the way a card prints it", () => {
    it("reads four digits as a month and a year", () => {
        expect(cards.readCardExpiry("0830")).toEqual({ month: "08", year: "2030" });
    });

    it("reads it however it was punctuated", () => {
        for (const typed of ["08/30", "08 / 30", "08-2030", "082030"]) {
            expect(cards.readCardExpiry(typed)).toEqual({ month: "08", year: "2030" });
        }
    });

    it("refuses a month that is not one", () => {
        // The transposition this is most likely to catch: 13/08 for 08/13.
        expect(cards.readCardExpiry("1330")).toBeNull();
        expect(cards.readCardExpiry("0030")).toBeNull();
    });

    it("refuses what is not an expiry at all", () => {
        expect(cards.readCardExpiry("")).toBeNull();
        expect(cards.readCardExpiry("8")).toBeNull();
        expect(cards.readCardExpiry("08301")).toBeNull();
    });

    it("writes it back into the one box", () => {
        expect(cards.writeCardExpiry({ month: "08", year: "2030" })).toBe("08/30");
        expect(cards.writeCardExpiry({ month: "8", year: "2030" })).toBe("08/30");
    });
});

describe("whether a card is still good", () => {
    const expiry = { month: "08", year: "2030" };

    it("is good through the last day of the month it names", () => {
        // Which is what the date on the front means, and a month more than
        // "before that month" would give.
        expect(cards.cardExpired(expiry, new Date(2030, 7, 31))).toBe(false);
        expect(cards.cardExpired(expiry, new Date(2030, 8, 1))).toBe(true);
    });

    it("is worth mentioning before it stops working, not after", () => {
        expect(cards.cardExpiringSoon(expiry, new Date(2030, 6, 1))).toBe(true);
        expect(cards.cardExpiringSoon(expiry, new Date(2029, 6, 1))).toBe(false);
        // Already gone is not "soon", it is a different sentence.
        expect(cards.cardExpiringSoon(expiry, new Date(2031, 0, 1))).toBe(false);
    });

    it("says nothing about a card with no expiry on it", () => {
        expect(cards.cardExpired({ month: "", year: "" }, new Date())).toBe(false);
    });
});
