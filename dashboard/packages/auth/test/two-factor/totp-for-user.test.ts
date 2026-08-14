/**
 * Checking an authenticator code without a session.
 *
 * The vault needs this because a Bitwarden client posts a code to an API with no
 * cookie behind it, and it is the one place Polaris computes a TOTP itself
 * rather than asking better-auth. That makes a known-answer test the point of
 * this file: the RFC 6238 vector proves the algorithm, the period and the digit
 * count all match what an authenticator app will produce, and a mistake in any
 * of them would look like "my code is always wrong" with nothing to point at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** RFC 6238's test secret, used verbatim as the HMAC key. */
const SECRET = "12345678901234567890";

const findFirst = vi.fn();
const decrypt = vi.fn(async () => SECRET);

vi.mock("@polaris/db", () => ({ prisma: { twoFactor: { findFirst } } }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "secret" }) }));
vi.mock("better-auth/crypto", () => ({ symmetricDecrypt: decrypt }));

const { verifyTotpForUser } = await import("../../src/totp.js");

const USER = "018f2b7a-0000-7000-8000-0000000000a1";

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    findFirst.mockResolvedValue({ secret: "encrypted" });
    decrypt.mockResolvedValue(SECRET);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("verifyTotpForUser", () => {
    it("accepts the code RFC 6238 says it should at that instant", async () => {
        // T = 59s, the first vector in the RFC. Its 8-digit answer is 94287082;
        // the last six are what a 6-digit authenticator shows.
        vi.setSystemTime(new Date(59 * 1000));
        expect(await verifyTotpForUser(USER, "287082")).toBe(true);
    });

    it("accepts the same code one step either side of now", async () => {
        // A phone whose clock is a little out, or somebody who started typing as
        // the code turned over.
        vi.setSystemTime(new Date(89 * 1000));
        expect(await verifyTotpForUser(USER, "287082")).toBe(true);
        vi.setSystemTime(new Date(29 * 1000));
        expect(await verifyTotpForUser(USER, "287082")).toBe(true);
    });

    it("refuses a code two steps out", async () => {
        vi.setSystemTime(new Date(129 * 1000));
        expect(await verifyTotpForUser(USER, "287082")).toBe(false);
    });

    it("ignores the spaces authenticator apps put in the middle", async () => {
        vi.setSystemTime(new Date(59 * 1000));
        expect(await verifyTotpForUser(USER, "287 082")).toBe(true);
    });

    it("refuses anything that is not six digits without looking anything up", async () => {
        expect(await verifyTotpForUser(USER, "12345")).toBe(false);
        expect(await verifyTotpForUser(USER, "abcdef")).toBe(false);
        expect(await verifyTotpForUser(USER, "")).toBe(false);
        expect(findFirst).not.toHaveBeenCalled();
    });

    it("refuses an account with no armed authenticator", async () => {
        vi.setSystemTime(new Date(59 * 1000));
        findFirst.mockResolvedValueOnce(null);
        expect(await verifyTotpForUser(USER, "287082")).toBe(false);
    });

    it("refuses rather than throwing when the stored secret cannot be read", async () => {
        // A changed instance secret, an interrupted write: the account cannot
        // answer, and the caller must get a plain no rather than a 500.
        vi.setSystemTime(new Date(59 * 1000));
        decrypt.mockRejectedValueOnce(new Error("bad key"));
        expect(await verifyTotpForUser(USER, "287082")).toBe(false);
    });

    it("only ever consults a verified authenticator", async () => {
        vi.setSystemTime(new Date(59 * 1000));
        await verifyTotpForUser(USER, "287082");
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER, verified: true } })
        );
    });
});
