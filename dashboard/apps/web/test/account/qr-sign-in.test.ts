/**
 * Signing in by scanning the code on the sign-in screen.
 *
 * The whole feature rests on one claim: a scanned code lets a browser in only
 * when somebody already signed in says so AND types the quick-unlock PIN. That
 * is the same bar as allowing a waiting sign-in from Account > Sessions, and it
 * exists because an unlocked dashboard somebody walked up to is not proof of who
 * is standing at it.
 *
 * So what is pinned here is the refusals: no PIN set, a wrong PIN, a code that
 * belongs to another account, one that has run out, and one that was already
 * answered. Plus the two things the approved path must do in order - leave the
 * pass that stops the new session being held for a second approval, and only
 * then spend the code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DeviceRow {
    userCode: string;
    userId: string | null;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    requestIp: string | null;
    requestUserAgent: string | null;
    requestHost: string | null;
    deviceCode?: string;
}

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

let rows: DeviceRow[] = [];
let hasPin = true;
let pinAccepted = true;
let throttled = false;
/** Every call the flow made, in order, so the sequence can be asserted. */
let calls: string[] = [];

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
    cookies: async () => ({ set: () => undefined })
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        deviceCode: {
            findUnique: async ({ where }: { where: { userCode?: string; deviceCode?: string } }) =>
                rows.find(
                    (row) =>
                        (where.userCode !== undefined && row.userCode === where.userCode) ||
                        (where.deviceCode !== undefined && row.deviceCode === where.deviceCode)
                ) ?? null,
            update: async () => undefined,
            deleteMany: async () => {
                calls.push("sweep");
                return { count: 0 };
            }
        },
        session: { findMany: async () => [] }
    }
}));

vi.mock("@polaris/auth", () => ({
    openDeviceCode: async () => {
        calls.push("open");
        return {
            deviceCode: "device-secret",
            userCode: "ABCD1234",
            expiresAt: new Date(Date.now() + 120_000),
            pollIntervalMs: 3000
        };
    },
    claimDeviceCode: async () => {
        calls.push("claim");
        return true;
    },
    decideDeviceCode: async (_auth: unknown, _code: string, approve: boolean) => {
        calls.push(approve ? "approve" : "deny");
        return {};
    },
    exchangeDeviceCode: async () => {
        calls.push("exchange");
        return { status: "approved" as const, cookies: [] };
    },
    beginSessionRotation: async () => {
        calls.push("rotation-pass");
    },
    getUserSecurity: async () => ({ hasPin }),
    verifyQuickPin: async () => {
        calls.push("pin");
        return pinAccepted;
    }
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/geo-service", () => ({ resolveGeo: async () => ({ countryCode: "ES" }) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !throttled, retryAfterMs: 900_000 })
}));

const { decideSignInCode, describeSignInCode, openSignInCode, redeemSignInCode } = await import(
    "../../src/lib/qr-sign-in-service"
);

/** A code waiting on a decision, unclaimed unless a holder is named. */
function waiting(overrides: Partial<DeviceRow> = {}): DeviceRow {
    return {
        userCode: "ABCD1234",
        userId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        requestIp: "203.0.113.9",
        requestUserAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140",
        requestHost: "polaris.example.com",
        deviceCode: "device-secret",
        ...overrides
    };
}

beforeEach(() => {
    rows = [waiting()];
    hasPin = true;
    pinAccepted = true;
    throttled = false;
    calls = [];
});

describe("the code the sign-in screen shows", () => {
    it("encodes a link to the answering screen on the Polaris domain", async () => {
        const { code } = await openSignInCode();
        expect(code?.url).toBe("https://polaris.example.com/account/scan?code=ABCD1234");
        expect(code?.userCode).toBe("ABCD1234");
    });

    it("clears the codes nobody came back for on the way", async () => {
        await openSignInCode();
        expect(calls).toEqual(["sweep", "open"]);
    });

    it("is not opened at all once the address has asked too often", async () => {
        throttled = true;
        const result = await openSignInCode();
        expect(result.code).toBeUndefined();
        expect(result.error).toBeTruthy();
        expect(calls).toEqual([]);
    });
});

describe("what the person answering is shown", () => {
    it("names the device and where it is signing in from", async () => {
        const request = await describeSignInCode("ABCD1234", OWNER);
        expect(request?.device).toBe("Chrome on Windows");
        // The device has its own line, so this one is the address alone.
        expect(request?.origin).toBe("203.0.113.9 - ES");
        expect(request?.host).toBe("polaris.example.com");
    });

    it("shows nothing for a code somebody else has already claimed", async () => {
        rows = [waiting({ userId: STRANGER })];
        expect(await describeSignInCode("ABCD1234", OWNER)).toBeNull();
    });

    it("shows nothing for a code that has run out or been answered", async () => {
        rows = [waiting({ expiresAt: new Date(Date.now() - 1000) })];
        expect(await describeSignInCode("ABCD1234", OWNER)).toBeNull();
        rows = [waiting({ status: "approved" })];
        expect(await describeSignInCode("ABCD1234", OWNER)).toBeNull();
    });
});

describe("allowing a sign-in", () => {
    it("goes through on the right PIN", async () => {
        const result = await decideSignInCode(OWNER, { userCode: "ABCD1234", approve: true, pin: "1234" });
        expect(result.error).toBeUndefined();
        expect(calls).toEqual(["pin", "claim", "approve"]);
    });

    it("refuses an account that has never set a PIN, and says where to set one", async () => {
        hasPin = false;
        const result = await decideSignInCode(OWNER, { userCode: "ABCD1234", approve: true, pin: "1234" });
        expect(result.error).toContain("PIN");
        expect(calls).not.toContain("approve");
    });

    it("refuses a wrong PIN without answering the code", async () => {
        pinAccepted = false;
        const result = await decideSignInCode(OWNER, { userCode: "ABCD1234", approve: true, pin: "9999" });
        expect(result.error).toBe("That PIN is not right.");
        expect(calls).toEqual(["pin"]);
    });

    it("stops guessing once the attempts run out, before the PIN is even checked", async () => {
        throttled = true;
        const result = await decideSignInCode(OWNER, { userCode: "ABCD1234", approve: true, pin: "1234" });
        expect(result.error).toContain("Too many attempts");
        expect(calls).toEqual([]);
    });

    it("will not answer a code claimed by another account", async () => {
        rows = [waiting({ userId: STRANGER })];
        const result = await decideSignInCode(OWNER, { userCode: "ABCD1234", approve: true, pin: "1234" });
        expect(result.error).toContain("no longer valid");
        expect(calls).toEqual([]);
    });
});

describe("refusing a sign-in", () => {
    it("costs no PIN - it only ever closes a door", async () => {
        const result = await decideSignInCode(OWNER, { userCode: "ABCD1234", approve: false, pin: "" });
        expect(result.error).toBeUndefined();
        expect(calls).toEqual(["claim", "deny"]);
    });
});

describe("the waiting screen's poll", () => {
    it("leaves the pass that spares the new session a second approval, then spends the code", async () => {
        rows = [waiting({ status: "approved", userId: OWNER })];
        expect(await redeemSignInCode("device-secret")).toBe("approved");
        expect(calls).toEqual(["rotation-pass", "exchange"]);
    });

    it("leaves no pass for a code nobody has answered yet", async () => {
        expect(await redeemSignInCode("device-secret")).toBe("approved");
        expect(calls).toEqual(["exchange"]);
    });

    it("reports an unknown code as over rather than asking the flow", async () => {
        rows = [];
        expect(await redeemSignInCode("device-secret")).toBe("expired");
        expect(calls).toEqual([]);
    });
});
