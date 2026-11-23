/**
 * The enrollment step's phone actions act only for an account the phone
 * requirement is holding right now, and never without a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    session: { id: "user-1", email: "a@example.test", name: "A" } as { id: string } | null,
    owes: true,
    steps: {
        setPhoneFor: vi.fn(async (_id: string, _input: unknown) => ({})),
        removePhoneFor: vi.fn(async (_id: string, _password: unknown) => ({})),
        sendPhoneCodeFor: vi.fn(async (_id: string) => ({})),
        verifyPhoneFor: vi.fn(async (_id: string, _code: unknown) => ({}))
    }
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/session", () => ({ resolveSession: async () => state.session }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@polaris/auth", () => ({ setTotpUnclaimed: vi.fn() }));
vi.mock("@/lib/second-factor-enrollment", () => ({ armFactorByEmail: vi.fn(), sendEnrollmentCode: vi.fn() }));
vi.mock("@/lib/instance-security", () => ({
    enrollmentOptions: vi.fn(),
    owesSecondFactor: vi.fn(),
    owesPhone: vi.fn(async () => state.owes)
}));
vi.mock("@/app/(app)/account/security/phone-steps", () => state.steps);

const actions = await import("@/app/oauth/enroll/actions");

beforeEach(() => {
    state.session = { id: "user-1" };
    state.owes = true;
    for (const step of Object.values(state.steps)) step.mockClear();
});

describe("the enrollment step's phone actions", () => {
    it("act on the held account", async () => {
        await actions.enrollSetPhoneAction({ phone: "+34600111222", password: "pw" });
        await actions.enrollSendPhoneCodeAction();
        await actions.enrollVerifyPhoneAction("123456");
        await actions.enrollRemovePhoneAction("pw");
        expect(state.steps.setPhoneFor).toHaveBeenCalledWith("user-1", { phone: "+34600111222", password: "pw" });
        expect(state.steps.sendPhoneCodeFor).toHaveBeenCalledWith("user-1");
        expect(state.steps.verifyPhoneFor).toHaveBeenCalledWith("user-1", "123456");
        expect(state.steps.removePhoneFor).toHaveBeenCalledWith("user-1", "pw");
    });

    it("refuse an account the requirement is not holding", async () => {
        state.owes = false;
        expect(await actions.enrollSetPhoneAction({ phone: "+34600111222", password: "pw" })).toEqual({
            error: "enroll.phone.nothingOwed"
        });
        expect(await actions.enrollVerifyPhoneAction("123456")).toEqual({ error: "enroll.phone.nothingOwed" });
        expect(state.steps.setPhoneFor).not.toHaveBeenCalled();
        expect(state.steps.verifyPhoneFor).not.toHaveBeenCalled();
    });

    it("refuse without a session", async () => {
        state.session = null;
        expect(await actions.enrollSendPhoneCodeAction()).toEqual({ error: "enroll.errors.signInAgain" });
        expect(state.steps.sendPhoneCodeFor).not.toHaveBeenCalled();
    });
});
