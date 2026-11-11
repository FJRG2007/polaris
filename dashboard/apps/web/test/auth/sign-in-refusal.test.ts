/**
 * A refused password sign-in says why, when the why is not the password.
 *
 * An install opened on its LAN IP was refused by the origin check, and the
 * screen said "wrong email or password" to somebody whose account was fine.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/oauth/sign-in-address", () => ({
    signInAddressAction: async () => "http://polaris.local"
}));

const { refusalMessage, signInRefusal } = await import("@/app/oauth/sign-in-refusal");

const t = (key: string, values?: { address: string }) =>
    values ? `${key}:${values.address}` : key;

describe("sign-in refusals", () => {
    it("tells an untrusted address apart from a wrong password", () => {
        expect(signInRefusal({ code: "INVALID_ORIGIN", status: 403 })).toBe("address");
        expect(signInRefusal({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 })).toBe("credentials");
        expect(signInRefusal({ status: 500 })).toBe("failed");
        expect(signInRefusal(null)).toBeNull();
    });

    it("keeps one sentence for every other refusal", () => {
        expect(signInRefusal({ code: "SOMETHING_ELSE", status: 403 })).toBe("credentials");
    });

    it("names the address sign-in works on", async () => {
        expect(await refusalMessage("address", t)).toBe("login.wrongAddress:http://polaris.local");
        expect(await refusalMessage("credentials", t)).toBe("login.invalid");
    });
});
