/**
 * One-time codes, against the vectors in the specification that defines them.
 *
 * This had no tests at all, which for a one-time password is the worst place to
 * have none: a wrong code is indistinguishable from a wrong clock, from a
 * mistyped secret, and from the site being broken - so it is the kind of fault
 * people work around for months instead of reporting. The vectors below are RFC
 * 6238's own (appendix B), computed from the seed the RFC publishes, so passing
 * them means the codes are the ones every authenticator agrees on.
 *
 * The seed is the RFC's ASCII "12345678901234567890", which in base32 - how every
 * authenticator writes a secret - is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
 */

import { parseTotp, totpCode, totpRemaining } from "../src/totp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const uri = (digits: number, algorithm = "SHA1"): string =>
    `otpauth://totp/Polaris:someone@example.com?secret=${SEED}&digits=${digits}&period=30&algorithm=${algorithm}`;

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the code for a moment in time", () => {
    // RFC 6238 appendix B, the SHA-1 rows: T=59, 1111111109, 1111111111.
    it.each([
        [59, "94287082"],
        [1_111_111_109, "07081804"],
        [1_111_111_111, "14050471"],
        [1_234_567_890, "89005924"]
    ])("matches the specification at %i seconds", async (seconds, expected) => {
        vi.setSystemTime(seconds * 1000);
        expect(await totpCode(uri(8))).toBe(expected);
    });

    it("gives six digits when nobody asked for eight", async () => {
        // What a bare secret means, and what almost every site issues.
        vi.setSystemTime(59_000);
        const code = await totpCode(SEED);
        expect(code).toHaveLength(6);
        // The same digits as the eight-digit answer, minus the leading two.
        expect(code).toBe("287082");
    });

    it("holds steady inside a period and turns over at its edge", async () => {
        vi.setSystemTime(30_000);
        const first = await totpCode(SEED);
        vi.setSystemTime(59_999);
        expect(await totpCode(SEED)).toBe(first);
        vi.setSystemTime(60_000);
        expect(await totpCode(SEED)).not.toBe(first);
    });

    it("says nothing rather than guessing when the value is not a secret", async () => {
        expect(await totpCode("")).toBeNull();
        expect(await totpCode("not base32 at all !!")).toBeNull();
        expect(await totpCode("otpauth://totp/x?digits=6")).toBeNull();
    });
});

describe("reading what somebody stored", () => {
    it("takes a bare secret to mean the ordinary defaults", () => {
        expect(parseTotp(SEED)).toEqual({
            secret: SEED,
            digits: 6,
            period: 30,
            algorithm: "SHA-1"
        });
    });

    it("reads a URI's own digits, period and algorithm", () => {
        expect(parseTotp(uri(8, "SHA256"))).toMatchObject({
            digits: 8,
            period: 30,
            algorithm: "SHA-256"
        });
    });

    it("refuses a URI with no usable secret", () => {
        expect(parseTotp("otpauth://totp/Polaris?secret=not-base32!")).toBeNull();
        expect(parseTotp("   ")).toBeNull();
    });

    it("ignores the spaces and padding people paste", () => {
        expect(parseTotp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq=")).not.toBeNull();
    });
});

describe("how long the code has left", () => {
    it("counts down to the turnover rather than up from it", () => {
        vi.setSystemTime(30_000);
        expect(totpRemaining(SEED)).toBe(30);
        vi.setSystemTime(45_000);
        expect(totpRemaining(SEED)).toBe(15);
        vi.setSystemTime(59_000);
        expect(totpRemaining(SEED)).toBe(1);
    });
});
