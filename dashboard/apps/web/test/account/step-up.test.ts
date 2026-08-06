/**
 * Proving an open session is still its owner, right before something final.
 *
 * The rule this exists to hold is the one that is easy to lose: what the account
 * armed decides what it is asked for. An account with a second factor must not
 * be able to answer with its password instead, or the gate quietly becomes the
 * thing it was added to strengthen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const describeMethods = vi.fn(async () => [] as unknown[]);
const deliverCode = vi.fn(async () => ({}) as { error?: string });
const verifyAccountPassword = vi.fn(async () => true);
const verifyTotpForSession = vi.fn(async () => true);
const verifyStepUpCode = vi.fn(async () => ({}) as { error?: string });
const issueStepUpCode = vi.fn(async () => "123456");
const rateLimit = vi.fn(async () => ({ ok: true, retryAfterMs: 0 }));
const recordAudit = vi.fn(async () => undefined);

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/two-factor-delivery", () => ({ describeTwoFactorMethods: describeMethods, deliverCode }));
vi.mock("@polaris/auth", () => ({
    issueStepUpCode,
    verifyStepUpCode,
    verifyAccountPassword,
    verifyTotpForSession
}));

const { proveStepUp, sendStepUpCode, stepUpOptions } = await import("../../src/lib/step-up");

/** What describeTwoFactorMethods answers, in the catalogue's own order. */
function methods(...on: { method: string; target?: string }[]) {
    describeMethods.mockResolvedValue(
        on.map((entry) => ({
            method: entry.method,
            enabled: true,
            available: true,
            target: entry.target ?? null,
            blocker: null
        }))
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    describeMethods.mockResolvedValue([]);
    rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
});

describe("stepUpOptions", () => {
    it("offers the password only when the account armed no factor", async () => {
        const { choices, preferred } = await stepUpOptions("u1");
        expect(choices.map((choice) => choice.proof)).toEqual(["password"]);
        expect(preferred).toBe("password");
    });

    it("offers the factors and not the password once one is armed", async () => {
        methods({ method: "totp" }, { method: "email", target: "an**@example.com" });
        const { choices, preferred } = await stepUpOptions("u1");
        expect(choices.map((choice) => choice.proof)).toEqual(["totp", "email"]);
        expect(preferred).toBe("totp");
        // Only the delivered ones need a code asked for first.
        expect(choices.map((choice) => choice.sends)).toEqual([false, true]);
    });
});

describe("proveStepUp", () => {
    it("refuses a password when the account has a second factor", async () => {
        methods({ method: "totp" });
        const result = await proveStepUp("u1", "org-delete:o1", { proof: "password", password: "hunter2" });
        expect(result.error).toBeTruthy();
        expect(verifyAccountPassword).not.toHaveBeenCalled();
    });

    it("refuses a method the account never turned on", async () => {
        methods({ method: "totp" });
        const result = await proveStepUp("u1", "org-delete:o1", { proof: "email", code: "123456" });
        expect(result.error).toBeTruthy();
        expect(verifyStepUpCode).not.toHaveBeenCalled();
    });

    it("checks an authenticator code against the live session", async () => {
        methods({ method: "totp" });
        expect(await proveStepUp("u1", "org-delete:o1", { proof: "totp", code: "123456" })).toEqual({});
        expect(verifyTotpForSession).toHaveBeenCalled();
    });

    it("spends a delivered code against the purpose it was minted for", async () => {
        methods({ method: "email", target: "an**@example.com" });
        await proveStepUp("u1", "org-delete:o1", { proof: "email", code: "123456" });
        expect(verifyStepUpCode).toHaveBeenCalledWith({}, "u1", "org-delete:o1", "123456");
    });

    it("accepts the password when there is no factor to ask for", async () => {
        expect(await proveStepUp("u1", "org-delete:o1", { proof: "password", password: "hunter2" })).toEqual({});
        expect(verifyAccountPassword).toHaveBeenCalled();
    });

    it("says a wrong password is wrong, and does not act", async () => {
        verifyAccountPassword.mockResolvedValue(false);
        const result = await proveStepUp("u1", "org-delete:o1", { proof: "password", password: "nope" });
        expect(result.error).toBeTruthy();
    });

    it("stops answering once the attempts are spent", async () => {
        rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 120_000 });
        const result = await proveStepUp("u1", "org-delete:o1", { proof: "password", password: "hunter2" });
        expect(result.error).toContain("Too many attempts");
        expect(verifyAccountPassword).not.toHaveBeenCalled();
    });
});

describe("sendStepUpCode", () => {
    it("refuses a method the account cannot receive on", async () => {
        methods({ method: "totp" });
        const result = await sendStepUpCode("u1", "org-delete:o1", "whatsapp");
        expect(result.error).toBeTruthy();
        expect(issueStepUpCode).not.toHaveBeenCalled();
    });

    it("mints and delivers for a method the account has open", async () => {
        methods({ method: "email", target: "an**@example.com" });
        expect(await sendStepUpCode("u1", "org-delete:o1", "email")).toEqual({});
        expect(issueStepUpCode).toHaveBeenCalledWith({}, "u1", "org-delete:o1");
        expect(deliverCode).toHaveBeenCalledWith("u1", "email", expect.objectContaining({ subject: expect.any(String) }));
    });
});
