/**
 * Asking whether a password is already public, without sending it anywhere.
 *
 * Two things are pinned. The first is the padding: the corpus answers with real
 * hashes mixed into invented ones whose count is zero, so "the hash is in the
 * answer" is not the question - the count is, and reading it wrong turns every
 * password into a breached one. The second is that the whole thing fails open: a
 * server that cannot be reached must produce "unknown", never "breached" and
 * never "fine".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { breachCount, countIn, sha1Hex } from "../src/lib/breach";

/** The corpus's own answer for "password", cut down to the lines that matter. */
const RANGE = ["1E4C9B93F3F0682250B6CF8331B7EE68FD8:37359195", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0"].join(
    "\r\n"
);

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("reading a range answer", () => {
    it("finds the count for a hash that is in it", () => {
        expect(countIn(RANGE, "1E4C9B93F3F0682250B6CF8331B7EE68FD8")).toBe(37_359_195);
    });

    it("reads a padded line as a password nobody has seen", () => {
        // The corpus pads its answers so the size of one says nothing. A padded
        // line is present and its count is zero, which is what "not breached"
        // looks like.
        expect(countIn(RANGE, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")).toBe(0);
    });

    it("says zero for a hash the answer does not carry", () => {
        expect(countIn(RANGE, "0000000000000000000000000000000000A")).toBe(0);
    });
});

describe("hashing a password", () => {
    it("produces the uppercase hexadecimal the corpus is indexed by", async () => {
        // The published vector for "password", which is also how the prefix and
        // the suffix are split.
        expect(await sha1Hex("password")).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
    });
});

describe("asking Polaris about a password", () => {
    it("sends five characters of the hash and nothing else", async () => {
        let asked = "";
        vi.stubGlobal("fetch", async (url: string) => {
            asked = url;
            return { ok: true, text: async () => RANGE };
        });

        expect(await breachCount("https://polaris.example", "password")).toBe(37_359_195);
        expect(asked).toBe("https://polaris.example/api/polaris/pwned/5BAA6");
        expect(asked).not.toContain("password");
    });

    it("answers unknown rather than safe when the server cannot be reached", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new Error("net::ERR_CONNECTION_REFUSED");
        });
        expect(await breachCount("https://polaris.example", "password")).toBeNull();
    });

    it("answers unknown when the server refuses", async () => {
        vi.stubGlobal("fetch", async () => ({ ok: false, text: async () => "" }));
        expect(await breachCount("https://polaris.example", "password")).toBeNull();
    });

    it("does not ask about something nobody has finished typing", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new Error("nothing should have been asked");
        });
        expect(await breachCount("https://polaris.example", "abc")).toBeNull();
    });
});
