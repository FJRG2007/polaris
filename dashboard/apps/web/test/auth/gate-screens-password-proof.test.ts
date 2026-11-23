/**
 * The screens that clear a gate - the idle lock, an owed second factor, an owed
 * security key - take the password or its OPAQUE proof (docs/chat-e2ee-phase1.md,
 * "Password flows over OPAQUE"). Pinned: each runs its own check through
 * `withGatePasswordOrProof` bound to the session it resolved itself, a proof that
 * does not check out is a wrong password, and nothing is unlocked, confirmed or
 * armed on one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    session: { id: "u1", sessionId: "s1", email: "user@example.com", name: "User", isAdmin: false } as
        | { id: string; sessionId: string; email: string; name: string; isAdmin: boolean }
        | null,
    // What the proof helper answers: the check's result, or null for a proof that failed.
    gate: vi.fn(),
    verifyAccountPassword: vi.fn(async () => true),
    confirmAccountPassword: vi.fn(async () => true),
    armFactorByEmail: vi.fn(async () => ({ backupCodes: ["code-1"] })),
    startAuthenticator: vi.fn(async () => ({ totpURI: "otpauth://totp/x", backupCodes: ["code-1"] })),
    unlocked: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/session", () => ({ resolveSession: async () => state.session }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }), resetRateLimit: vi.fn() }));
vi.mock("@/lib/passkey-announce", () => ({ announceNewPasskey: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: { sessionState: { updateMany: state.unlocked } } }));
vi.mock("@polaris/auth", () => ({
    verifyAccountPassword: state.verifyAccountPassword,
    verifyQuickPin: vi.fn(async () => true),
    confirmAccountPassword: state.confirmAccountPassword,
    setTotpUnclaimed: vi.fn()
}));
vi.mock("@/lib/chat/e2ee/opaque-password", () => ({ withGatePasswordOrProof: state.gate }));
vi.mock("@/lib/second-factor-enrollment", () => ({
    armFactorByEmail: state.armFactorByEmail,
    sendEnrollmentCode: vi.fn(),
    startAuthenticator: state.startAuthenticator
}));
vi.mock("@/lib/instance-security", () => ({
    enrollmentOptions: vi.fn(),
    owesPhone: vi.fn(),
    owesSecondFactor: vi.fn()
}));
vi.mock("@/app/(app)/account/security/phone-steps", () => ({}));

const lock = await import("@/app/oauth/lock/actions");
const securityKey = await import("@/app/oauth/security-key/actions");
const enroll = await import("@/app/oauth/enroll/actions");

const PROOF = { loginId: "00000000-0000-4000-8000-000000000000", finishLoginRequest: "A".repeat(64) };

/** The helper as it behaves: runs the check on a stand-in, or answers null. */
function proofChecksOut(ok: boolean): void {
    state.gate.mockImplementation(async (_session: unknown, _given: unknown, run: (password: string) => unknown) =>
        ok ? run("stand-in") : null
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    state.session = { id: "u1", sessionId: "s1", email: "user@example.com", name: "User", isAdmin: false };
});

describe("the lock screen", () => {
    it("unlocks on a proof, checked on the session it resolved", async () => {
        proofChecksOut(true);
        expect(await lock.unlockSessionAction(PROOF, "password")).toEqual({});
        expect(state.gate).toHaveBeenCalledWith(state.session, PROOF, expect.any(Function));
        expect(state.verifyAccountPassword).toHaveBeenCalledWith({}, "u1", "stand-in");
        expect(state.unlocked).toHaveBeenCalledOnce();
    });

    it("a proof that does not check out is a wrong password and unlocks nothing", async () => {
        proofChecksOut(false);
        expect(await lock.unlockSessionAction(PROOF, "password")).toEqual({ error: "lock.errors.wrongPassword" });
        expect(state.unlocked).not.toHaveBeenCalled();
    });

    it("a PIN never goes through the proof", async () => {
        expect(await lock.unlockSessionAction("1234", "pin")).toEqual({});
        expect(state.gate).not.toHaveBeenCalled();
    });
});

describe("the security-key screen", () => {
    it("confirms the password on a proof, and refuses one that fails", async () => {
        proofChecksOut(true);
        expect(await securityKey.confirmPasswordForKeyAction(PROOF)).toEqual({});
        expect(state.confirmAccountPassword).toHaveBeenCalledWith({}, "u1", "s1", "stand-in");
        proofChecksOut(false);
        expect(await securityKey.confirmPasswordForKeyAction(PROOF)).toEqual({ error: "known.wrongPassword" });
    });

    it("without a session asks to sign in, before any proof is finished", async () => {
        state.session = null;
        expect(await securityKey.confirmPasswordForKeyAction(PROOF)).toEqual({ error: "securityKey.signedOut" });
        expect(state.gate).not.toHaveBeenCalled();
    });
});

describe("the enrollment screen", () => {
    it("arms the email factor on a proof, and a failed proof spends no code", async () => {
        proofChecksOut(true);
        expect(await enroll.armByEmailAction(PROOF, "123456")).toMatchObject({ backupCodes: ["code-1"] });
        expect(state.armFactorByEmail).toHaveBeenCalledWith("u1", expect.any(Headers), "stand-in", "123456");
        state.armFactorByEmail.mockClear();
        proofChecksOut(false);
        expect(await enroll.armByEmailAction(PROOF, "123456")).toEqual({ error: "lock.errors.wrongPassword" });
        expect(state.armFactorByEmail).not.toHaveBeenCalled();
        expect(await enroll.armByEmailAction("", "123456")).toEqual({ error: "enroll.errors.enterPassword" });
    });

    it("starts the authenticator on a proof only, never on a typed password", async () => {
        proofChecksOut(true);
        expect(await enroll.startAuthenticatorAction(PROOF)).toEqual({
            totpURI: "otpauth://totp/x",
            backupCodes: ["code-1"]
        });
        expect(state.startAuthenticator).toHaveBeenCalledWith(expect.any(Headers), "stand-in");
        expect(await enroll.startAuthenticatorAction("the password")).toEqual({
            error: "enroll.authenticator.startFailed"
        });
        proofChecksOut(false);
        expect(await enroll.startAuthenticatorAction(PROOF)).toEqual({ error: "enroll.authenticator.startFailed" });
    });
});
