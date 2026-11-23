/**
 * A number somebody else proves they hold: it moves off the account that had
 * it unless that would lock the account out, the account is told either way,
 * and nothing about it lands in the history of the one that proved it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PHONE_ID = "0190a000-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    otherConfirmed: 0,
    twoFactor: true,
    methods: [] as { method: string; target: string | null }[],
    approval: false,
    verify: vi.fn(),
    audit: vi.fn(async (_event: unknown) => {}),
    notify: vi.fn(async (_user: string, _phone: string, _outcome: string) => {})
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: state.audit }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/messaging-service", () => ({ normalizePeerId: (_p: string, id: string) => id }));
vi.mock("@/lib/messaging/code-senders", () => ({ phoneCodeRoute: vi.fn() }));
vi.mock("@/lib/notifications/sms-service", () => ({ sendSmsThroughChannel: vi.fn() }));
vi.mock("@/lib/messaging/channel-runtime", () => ({ sendCodeThroughChannel: vi.fn() }));
vi.mock("@/lib/instance-security", () => ({ getInstanceSecurity: async () => ({ requirePhone: false }) }));
vi.mock("@/lib/two-factor-delivery", () => ({ challengeOptions: async () => ({ methods: state.methods }) }));
vi.mock("@/lib/mobile/sign-in-approval", () => ({ phoneCanApprove: async () => state.approval }));
vi.mock("@/lib/notifications/security-events", () => ({ notifyPhoneClaimed: state.notify }));
vi.mock("@polaris/db", () => ({
    prisma: {
        userPhone: {
            count: async () => state.otherConfirmed,
            findFirst: async () => ({ phone: "+34600111222" })
        }
    }
}));
vi.mock("@polaris/auth", () => ({
    addUserPhone: vi.fn(),
    issuePhoneCode: vi.fn(),
    promoteUserPhone: vi.fn(),
    removeUserPhone: vi.fn(),
    twoFactorEnabled: async () => state.twoFactor,
    verifyPhoneCode: state.verify
}));

const steps = await import("@/app/(app)/account/security/phone-steps");

beforeEach(() => {
    state.otherConfirmed = 0;
    state.twoFactor = true;
    state.methods = [];
    state.approval = false;
    state.verify.mockReset();
    state.audit.mockClear();
    state.notify.mockClear();
});

describe("whether an account may lose a number", () => {
    it("may when it keeps another confirmed number or has no second step", async () => {
        state.otherConfirmed = 1;
        expect(await steps.mayLosePhone("owner", "+34600111222")).toBe(true);
        state.otherConfirmed = 0;
        state.twoFactor = false;
        expect(await steps.mayLosePhone("owner", "+34600111222")).toBe(true);
    });

    it("may not when the number is its only way to finish signing in", async () => {
        state.methods = [{ method: "sms", target: "***222" }, { method: "whatsapp", target: "***222" }];
        expect(await steps.mayLosePhone("owner", "+34600111222")).toBe(false);
    });

    it("may when an authenticator, another code or the mobile app is left", async () => {
        state.methods = [{ method: "sms", target: "***222" }, { method: "email", target: "a***@example.test" }];
        expect(await steps.mayLosePhone("owner", "+34600111222")).toBe(true);
        state.methods = [];
        state.approval = true;
        expect(await steps.mayLosePhone("owner", "+34600111222")).toBe(true);
    });
});

describe("confirming a number another account had", () => {
    it("tells that account, masked, with no actor on its record", async () => {
        state.verify.mockResolvedValue({ takenFrom: ["owner"] });
        expect(await steps.verifyPhoneFor("new", { id: PHONE_ID, code: "123456" })).toEqual({});
        expect(state.notify).toHaveBeenCalledWith("owner", expect.not.stringContaining("111222"), "taken");
        expect(state.audit).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: null, action: "account.phone.taken", targetId: "owner" })
        );
        expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: "new", action: "account.phone.verified" }));
    });

    it("warns the account that kept it, and answers the prover with the kept sentence only", async () => {
        state.verify.mockResolvedValue({
            error: "This number cannot be confirmed on this account. Use another number.",
            keptBy: ["owner"]
        });
        const result = await steps.verifyPhoneFor("new", { id: PHONE_ID, code: "123456" });
        expect(Object.keys(result)).toEqual(["error"]);
        expect(state.notify).toHaveBeenCalledWith("owner", expect.any(String), "kept");
        expect(state.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "account.phone.verified" }));
    });

    it("asks the holder check through mayTakeFrom", async () => {
        state.verify.mockResolvedValue({});
        state.methods = [{ method: "sms", target: "***222" }];
        await steps.verifyPhoneFor("new", { id: PHONE_ID, code: "123456" });
        const options = state.verify.mock.calls[0]![4] as { mayTakeFrom: (owner: string) => Promise<boolean> };
        expect(await options.mayTakeFrom("owner")).toBe(false);
    });
});
