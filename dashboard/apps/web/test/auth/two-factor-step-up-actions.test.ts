/**
 * Answering the extra steps. A WhatsApp or email code is only sent once the
 * number or address it goes to has been typed back, a method that is not owed changes nothing, and
 * the session opens only when the last owed step is answered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ sessionState: { findUnique: vi.fn() } }));
const stepUp = vi.hoisted(() => ({ proveStepUp: vi.fn(), sendStepUpCode: vi.fn() }));
const service = vi.hoisted(() => ({ advanceStepUp: vi.fn() }));
const authPkg = vi.hoisted(() => ({ getUserPhone: vi.fn(), verifySecurityAnswers: vi.fn() }));
const limits = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const delivery = vi.hoisted(() => ({ codeEmailAddress: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/session", () => ({ resolveSession: vi.fn(async () => ({ id: "user-1", sessionId: "session-1" })) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => limits);
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/step-up", () => stepUp);
vi.mock("@/lib/two-factor-policy-service", () => service);
vi.mock("@/lib/two-factor-policy-store", () => ({ rememberSignInCountry: vi.fn() }));
vi.mock("@polaris/auth", () => authPkg);
vi.mock("@/lib/two-factor-delivery", () => delivery);

import * as actions from "@/app/oauth/step-up/actions";
import { serializeStepUp, type StepUpState } from "@/lib/two-factor-policy";

const owing: StepUpState = {
    need: 2,
    accepted: ["totp", "email", "whatsapp"],
    done: ["totp"],
    question: false,
    questionDone: false,
    phoneConfirmed: false,
    emailConfirmed: true,
    reason: "unusual-country"
};

function stored(state: StepUpState) {
    db.sessionState.findUnique.mockResolvedValue({ stepUp: serializeStepUp(state), country: "US" });
}

beforeEach(() => {
    vi.clearAllMocks();
    limits.rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
    service.advanceStepUp.mockResolvedValue(true);
    stepUp.sendStepUpCode.mockResolvedValue({});
    stepUp.proveStepUp.mockResolvedValue({});
    authPkg.getUserPhone.mockResolvedValue({ phone: "+34600111222", verified: true });
    delivery.codeEmailAddress.mockResolvedValue("fran@example.com");
    stored(owing);
});

describe("confirming the number before a WhatsApp code", () => {
    it("sends nothing to a number that was not typed back correctly", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "whatsapp", phone: "600111999" })).toEqual({
            error: "stepUp.wrongPhone"
        });
        expect(await actions.sendStepUpFactorCodeAction({ method: "whatsapp" })).toEqual({ error: "stepUp.wrongPhone" });
        expect(stepUp.sendStepUpCode).not.toHaveBeenCalled();
        expect(limits.rateLimit).toHaveBeenCalledWith("step-up-phone:user-1", 5, expect.any(Number));
    });

    it("sends once the number matches, and remembers that it did", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "whatsapp", phone: "+34 600 111 222" })).toEqual({});
        expect(service.advanceStepUp.mock.calls[0]![2]).toMatchObject({ phoneConfirmed: true });
        expect(stepUp.sendStepUpCode).toHaveBeenCalledWith("user-1", "sign-in-step-up:whatsapp", "whatsapp", { anyReachable: true });
    });

    it("stops after too many tries", async () => {
        limits.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 60_000 });
        expect(await actions.sendStepUpFactorCodeAction({ method: "whatsapp", phone: "+34600111222" })).toEqual({
            error: "stepUp.tooMany"
        });
    });

    it("does not ask for a number before an email code", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "email" })).toEqual({});
        expect(authPkg.getUserPhone).not.toHaveBeenCalled();
    });
});

describe("confirming the address before an email code", () => {
    beforeEach(() => stored({ ...owing, emailConfirmed: false }));

    it("sends nothing to an address that was not typed back correctly", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "email", email: "fran@example.org" })).toEqual({
            error: "stepUp.wrongEmail"
        });
        expect(await actions.sendStepUpFactorCodeAction({ method: "email" })).toEqual({ error: "stepUp.wrongEmail" });
        expect(stepUp.sendStepUpCode).not.toHaveBeenCalled();
        expect(limits.rateLimit).toHaveBeenCalledWith("step-up-email:user-1", 5, expect.any(Number));
    });

    it("sends once the address matches in any casing, and remembers that it did", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "email", email: " Fran@Example.com " })).toEqual({});
        expect(service.advanceStepUp.mock.calls[0]![2]).toMatchObject({ emailConfirmed: true });
        expect(stepUp.sendStepUpCode).toHaveBeenCalledWith("user-1", "sign-in-step-up:email", "email", { anyReachable: true });
    });

    it("refuses an email code before the address was confirmed", async () => {
        expect(await actions.proveStepUpFactorAction({ method: "email", code: "123456" })).toEqual({ error: "stepUp.notOwed" });
        expect(stepUp.proveStepUp).not.toHaveBeenCalled();
    });
});

describe("confirming the number before a text-message code", () => {
    beforeEach(() => stored({ ...owing, accepted: ["totp", "email", "sms"] }));

    it("sends nothing to a number that was not typed back correctly", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "sms", phone: "600111999" })).toEqual({
            error: "stepUp.wrongPhone"
        });
        expect(stepUp.sendStepUpCode).not.toHaveBeenCalled();
    });

    it("sends once the number matches", async () => {
        expect(await actions.sendStepUpFactorCodeAction({ method: "sms", phone: "+34 600 111 222" })).toEqual({});
        expect(service.advanceStepUp.mock.calls[0]![2]).toMatchObject({ phoneConfirmed: true });
        expect(stepUp.sendStepUpCode).toHaveBeenCalledWith("user-1", "sign-in-step-up:sms", "sms", { anyReachable: true });
    });

    it("refuses a text-message code before the number was confirmed", async () => {
        expect(await actions.proveStepUpFactorAction({ method: "sms", code: "123456" })).toEqual({ error: "stepUp.notOwed" });
        expect(stepUp.proveStepUp).not.toHaveBeenCalled();
    });
});

describe("answering a factor", () => {
    it("refuses the method already answered", async () => {
        expect(await actions.proveStepUpFactorAction({ method: "totp", code: "123456" })).toEqual({ error: "stepUp.notOwed" });
        expect(stepUp.proveStepUp).not.toHaveBeenCalled();
    });

    it("refuses a WhatsApp code before the number was confirmed", async () => {
        expect(await actions.proveStepUpFactorAction({ method: "whatsapp", code: "123456" })).toEqual({ error: "stepUp.notOwed" });
    });

    it("opens the session when the last owed factor is right", async () => {
        expect(await actions.proveStepUpFactorAction({ method: "email", code: "123456" })).toEqual({ complete: true });
        expect(stepUp.proveStepUp).toHaveBeenCalledWith("user-1", "sign-in-step-up:email", { proof: "email", code: "123456" }, { anyReachable: true });
        expect(service.advanceStepUp.mock.calls[0]![2]).toBeNull();
    });

    it("keeps the session held when the code is wrong", async () => {
        stepUp.proveStepUp.mockResolvedValue({ error: "wrong" });
        expect(await actions.proveStepUpFactorAction({ method: "email", code: "123456" })).toEqual({ error: "wrong" });
        expect(service.advanceStepUp).not.toHaveBeenCalled();
    });

    it("keeps the questions owed after the methods", async () => {
        stored({ ...owing, question: true });
        expect(await actions.proveStepUpFactorAction({ method: "email", code: "123456" })).toEqual({ complete: false });
        expect(service.advanceStepUp.mock.calls[0]![2]).toMatchObject({ done: ["totp", "email"], questionDone: false });
    });
});

describe("the security questions", () => {
    it("opens the session only on the right answers", async () => {
        stored({ ...owing, done: ["totp", "email"], question: true });
        authPkg.verifySecurityAnswers.mockResolvedValue(false);
        expect(await actions.answerStepUpQuestionsAction({ answers: ["no"] })).toEqual({ error: "stepUp.wrongAnswers" });
        authPkg.verifySecurityAnswers.mockResolvedValue(true);
        expect(await actions.answerStepUpQuestionsAction({ answers: ["yes"] })).toEqual({ complete: true });
    });

    it("are not even checked while a code is still owed", async () => {
        stored({ ...owing, done: ["totp"], question: true });
        authPkg.verifySecurityAnswers.mockClear();
        authPkg.verifySecurityAnswers.mockResolvedValue(true);
        expect(await actions.answerStepUpQuestionsAction({ answers: ["yes"] })).toEqual({ error: "stepUp.notOwed" });
        expect(authPkg.verifySecurityAnswers).not.toHaveBeenCalled();
    });
});
