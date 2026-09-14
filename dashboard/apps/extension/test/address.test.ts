import { describe, expect, it } from "vitest";
import { looksLikeAddress, readOrigin } from "../src/lib/address";

/**
 * Deciding whether what has been typed is worth asking the browser about.
 *
 * These are two different questions and the screen needed the second one.
 * `readOrigin` answers "can this be turned into an origin at all", and the
 * answer for a single letter is yes: `a` becomes `https://a`, which parses.
 * So Continue lit up on the first keystroke, and pressing it spent the one
 * permission prompt a user gesture is good for on a host that cannot exist.
 *
 * What it must not become is a list of valid endings. A self-hosted Polaris
 * answers on whatever its owner owns - a LAN name, a machine on a home network,
 * something no public suffix list has heard of - and refusing those would be
 * refusing exactly the people this is for.
 */

describe("what enables the button", () => {
    it("refuses a name that is only a letter", () => {
        // The reported bug, verbatim: one character and the button went live.
        expect(looksLikeAddress("a")).toBe(false);
        expect(looksLikeAddress("po")).toBe(false);
    });

    it("refuses nothing at all", () => {
        expect(looksLikeAddress("")).toBe(false);
        expect(looksLikeAddress("   ")).toBe(false);
    });

    it("refuses a dot with a side missing", () => {
        expect(looksLikeAddress(".com")).toBe(false);
        expect(looksLikeAddress("polaris.")).toBe(false);
        expect(looksLikeAddress("polaris..com")).toBe(false);
    });

    it("accepts a real address, however it was typed", () => {
        expect(looksLikeAddress("polaris.example.com")).toBe(true);
        expect(looksLikeAddress("  polaris.example.com  ")).toBe(true);
        expect(looksLikeAddress("https://polaris.example.com")).toBe(true);
        expect(looksLikeAddress("https://polaris.example.com/vault")).toBe(true);
    });

    it("accepts the names a self-hosted server actually answers on", () => {
        // A LAN name and a machine by address. Neither is on anybody's list of
        // valid domains, and both are where Polaris usually lives.
        expect(looksLikeAddress("polaris.local")).toBe(true);
        expect(looksLikeAddress("localhost")).toBe(true);
        expect(looksLikeAddress("192.168.1.4:8080")).toBe(true);
    });
});

describe("reading it as an origin", () => {
    it("assumes https when no scheme was typed", () => {
        expect(readOrigin("polaris.example.com")).toBe("https://polaris.example.com");
    });

    it("keeps http when that is what was typed", () => {
        expect(readOrigin("http://polaris.local")).toBe("http://polaris.local");
    });

    it("drops the path people paste out of the address bar", () => {
        expect(readOrigin("https://polaris.example.com/vault")).toBe("https://polaris.example.com");
    });

    it("refuses what is not an address at all", () => {
        expect(readOrigin("")).toBeNull();
        expect(readOrigin("   ")).toBeNull();
        expect(readOrigin("ftp://polaris.example.com")).toBeNull();
    });
});
