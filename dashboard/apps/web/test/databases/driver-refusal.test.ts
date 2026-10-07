/**
 * A database turning a connection away is said, not hidden.
 *
 * A wrong password through an SSH tunnel answered "That did not work. Nothing
 * was changed." - while the log said `password authentication failed for user
 * "prisma"` - so the reader went back to the tunnel, which was fine.
 */

import { describe, expect, it, vi } from "vitest";
import { driverRefusal, DRIVER_REFUSALS } from "@/lib/data/driver-refusal";

vi.mock("@/lib/i18n/request", () => ({
    getTranslations: vi.fn(async () => (key: string) => key)
}));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));

function coded(code: string | number, message = "detail the reader must not see"): Error {
    return Object.assign(new Error(message), { code });
}

describe("a refused connection", () => {
    it("is a wrong password, whatever the engine", () => {
        expect(driverRefusal(coded("28P01"))).toBe(DRIVER_REFUSALS.credentials);
        expect(driverRefusal(coded("ER_ACCESS_DENIED_ERROR"))).toBe(DRIVER_REFUSALS.credentials);
        expect(driverRefusal(Object.assign(new Error("x"), { code: 18, codeName: "AuthenticationFailed" }))).toBe(
            DRIVER_REFUSALS.credentials
        );
        expect(driverRefusal(new Error("WRONGPASS invalid username-password pair"))).toBe(
            DRIVER_REFUSALS.credentials
        );
    });

    it("names a missing database, a closed port and a name that does not resolve", () => {
        expect(driverRefusal(coded("3D000"))).toBe(DRIVER_REFUSALS.noDatabase);
        expect(driverRefusal(coded("ER_BAD_DB_ERROR"))).toBe(DRIVER_REFUSALS.noDatabase);
        expect(driverRefusal(coded("ECONNREFUSED"))).toBe(DRIVER_REFUSALS.refused);
        expect(driverRefusal(coded("ENOTFOUND"))).toBe(DRIVER_REFUSALS.unknownHost);
    });

    it("reads a socket error a driver wrapped", () => {
        const wrapped = Object.assign(new Error("connect failed"), { cause: coded("ETIMEDOUT") });
        expect(driverRefusal(wrapped)).toBe(DRIVER_REFUSALS.timeout);
    });

    it("stops at causes that point back at each other", () => {
        const first = new Error("first");
        const second = Object.assign(new Error("second"), { cause: first });
        Object.assign(first, { cause: second });
        expect(driverRefusal(first)).toBeNull();
    });

    it("leaves anything else to the generic sentence", () => {
        expect(driverRefusal(new Error('relation "users" does not exist'))).toBeNull();
        expect(driverRefusal(coded("42P01"))).toBeNull();
        expect(driverRefusal(null)).toBeNull();
    });
});

describe("the action guard", () => {
    it("says the refusal, and never the driver's own words", async () => {
        const { guardData } = await import("@/lib/data/action-guard");
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await guardData(async () => {
            throw coded("28P01", 'password authentication failed for user "prisma"');
        });
        error.mockRestore();
        expect(result.error).toBe("refusals.driverCredentials");
        expect(result.error).not.toContain("prisma");
    });

    it("keeps a fault it does not know generic", async () => {
        const { guardData } = await import("@/lib/data/action-guard");
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await guardData(async () => {
            throw new Error("internal path /var/lib/x");
        });
        error.mockRestore();
        expect(result.error).toBe("refusals.generic");
    });
});
