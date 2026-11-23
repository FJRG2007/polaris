/**
 * The enrollment step's phone actions act only for an account the phone
 * requirement is holding right now, and never without a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PHONE_ID = "0190a000-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    session: { id: "user-1", email: "a@example.test", name: "A" } as { id: string } | null,
    owes: true,
    steps: {
        addPhoneFor: vi.fn(async (_id: string, _input: unknown) => ({ id: PHONE_ID })),
        removePhoneFor: vi.fn(async (_id: string, _input: unknown) => ({})),
        makePhonePrimaryFor: vi.fn(async (_id: string, _phoneId: unknown) => ({})),
        sendPhoneCodeFor: vi.fn(async (_id: string, _phoneId?: unknown) => ({})),
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
        expect(await actions.enrollAddPhoneAction({ phone: "+34600111222", password: "pw" })).toEqual({ id: PHONE_ID });
        await actions.enrollSendPhoneCodeAction(PHONE_ID);
        await actions.enrollVerifyPhoneAction({ id: PHONE_ID, code: "123456" });
        await actions.enrollMakePhonePrimaryAction(PHONE_ID);
        await actions.enrollRemovePhoneAction({ id: PHONE_ID, password: "pw" });
        expect(state.steps.addPhoneFor).toHaveBeenCalledWith("user-1", { phone: "+34600111222", password: "pw" });
        expect(state.steps.sendPhoneCodeFor).toHaveBeenCalledWith("user-1", PHONE_ID);
        expect(state.steps.verifyPhoneFor).toHaveBeenCalledWith("user-1", { id: PHONE_ID, code: "123456" });
        expect(state.steps.makePhonePrimaryFor).toHaveBeenCalledWith("user-1", PHONE_ID);
        expect(state.steps.removePhoneFor).toHaveBeenCalledWith("user-1", { id: PHONE_ID, password: "pw" });
    });

    it("refuse an account the requirement is not holding", async () => {
        state.owes = false;
        expect(await actions.enrollAddPhoneAction({ phone: "+34600111222", password: "pw" })).toEqual({
            error: "enroll.phone.nothingOwed"
        });
        expect(await actions.enrollVerifyPhoneAction("123456")).toEqual({ error: "enroll.phone.nothingOwed" });
        expect(state.steps.addPhoneFor).not.toHaveBeenCalled();
        expect(state.steps.verifyPhoneFor).not.toHaveBeenCalled();
    });

    it("refuse without a session", async () => {
        state.session = null;
        expect(await actions.enrollSendPhoneCodeAction(PHONE_ID)).toEqual({ error: "enroll.errors.signInAgain" });
        expect(state.steps.sendPhoneCodeFor).not.toHaveBeenCalled();
    });
});
