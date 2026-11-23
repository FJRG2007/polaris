/**
 * The second-factor actions that take a proof of the password instead of the
 * password (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE"): the
 * confirmation that saves methods, policy and approval gate on one proof, and
 * the authenticator's start and removal through better-auth's own endpoints.
 *
 * Pinned: one proof covers every step, each with a stand-in of its own; a proof
 * that does not hold runs nothing; a typed password still reaches every step;
 * the steps stop at the first refusal; and removal carries the rotated
 * session's cookies onto the response.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    proofHolds: true,
    standIns: 0,
    checked: [] as string[],
    forwarded: [] as Headers[],
    enabled: [] as unknown[],
    disabled: [] as unknown[],
    approval: [] as unknown[]
}));

/** A typed "right" password or a stand-in opens the check. */
const check = vi.hoisted(() => (password: string): boolean => {
    state.checked.push(password);
    return password === "right" || password.startsWith("stand-in:");
});

const PROOF = { loginId: "00000000-0000-4000-8000-000000000001", finishLoginRequest: "A".repeat(64) };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1", sessionId: "session-1" }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({
    localized: async (result: unknown) => result,
    firstIssue: async () => ({ error: "errors.checkForm" })
}));
vi.mock("@/app/(app)/account/security/known-sentences", () => ({ methodLabel: () => "method" }));
vi.mock("@/app/(app)/account/security/phone-steps", () => ({
    CODE_CHECK_LIMIT: 10,
    CODE_CHECK_WINDOW_MS: 60_000,
    CODE_SEND_LIMIT: 5,
    CODE_SEND_WINDOW_MS: 60_000
}));
vi.mock("@/lib/messaging/telegram-link", () => ({}));
vi.mock("@/lib/two-factor-delivery", () => ({
    describeTwoFactorMethods: async () => [{ method: "email", enabled: true, available: true }]
}));
vi.mock("@/lib/two-factor-policy-store", () => ({
    loadTwoFactorPolicy: async () => ({ refused: [], strictness: "any" }),
    saveTwoFactorPolicy: async () => {}
}));
vi.mock("@/lib/two-factor-policy", async () => {
    const { z } = await import("zod");
    return {
        twoFactorPolicySchema: z.object({ refused: z.array(z.string()), strictness: z.string() }),
        isStricter: () => false
    };
});
vi.mock("@polaris/core", async () => {
    const { z } = await import("zod");
    return { twoFactorPreferencesSchema: z.object({ methods: z.array(z.string()), preferred: z.string() }) };
});
vi.mock("@/lib/auth-cookies", () => ({
    forwardAuthCookies: async (headers: Headers) => {
        state.forwarded.push(headers);
    }
}));
vi.mock("@/app/(app)/account/security/actions", () => ({
    setLoginApprovalAction: async (required: boolean, password: string) => {
        state.approval.push(required);
        return check(password) ? {} : { error: "known.wrongPassword" };
    }
}));
vi.mock("@polaris/auth", () => ({
    getUserSecurity: async () => ({ twoFactorMethods: [] }),
    regenerateBackupCodes: async () => ({ codes: ["a"] }),
    setTwoFactorPreferences: async (_auth: unknown, _id: string, _input: unknown, password: string) =>
        check(password) ? {} : { error: "Current password is incorrect." },
    verifyAccountPassword: async (_auth: unknown, _id: string, password: string) => check(password),
    withProvenPassword: async (hash: string, run: (standIn: string) => Promise<unknown>) =>
        run(`stand-in:${hash}:${++state.standIns}`)
}));
vi.mock("@/lib/chat/e2ee/opaque-password", () => ({
    provenPasswordHash: async () => (state.proofHolds ? "hash" : null),
    withPasswordOrProof: async (_id: string, given: unknown, run: (password: string) => Promise<unknown>) =>
        typeof given === "string" ? run(given) : state.proofHolds ? run("stand-in:hash:x") : null,
    withPasswordProof: async (_id: string, _proof: unknown, run: (password: string) => Promise<unknown>) =>
        state.proofHolds ? run("stand-in:hash:x") : null
}));
vi.mock("@/lib/auth", () => ({
    auth: {
        api: {
            enableTwoFactor: async (input: { body: { password: string } }) => {
                state.enabled.push(input);
                if (!check(input.body.password)) throw new Error("INVALID_PASSWORD");
                return { totpURI: "otpauth://totp/x?secret=ABC", backupCodes: ["one", "two"] };
            },
            disableTwoFactor: async (input: { body: { password: string } }) => {
                state.disabled.push(input);
                if (!check(input.body.password)) throw new Error("INVALID_PASSWORD");
                return { headers: new Headers({ "set-cookie": "polaris.session_token=new; Path=/" }) };
            }
        }
    }
}));

const actions = await import("@/app/(app)/account/security/two-factor-actions");

const PREFERENCES = { methods: ["email"], preferred: "email" };
const POLICY = { refused: [], strictness: "any" };

beforeEach(() => {
    state.proofHolds = true;
    state.standIns = 0;
    state.checked.length = 0;
    state.forwarded.length = 0;
    state.enabled.length = 0;
    state.disabled.length = 0;
    state.approval.length = 0;
});

describe("saving the second-factor choices on one password", () => {
    it("one proof covers all three steps, each with a stand-in of its own", async () => {
        const result = await actions.saveTwoFactorChangesAction({
            preferences: PREFERENCES,
            policy: POLICY,
            approval: true,
            password: PROOF
        });
        expect(result).toEqual({});
        expect(state.checked).toEqual(["stand-in:hash:1", "stand-in:hash:2", "stand-in:hash:3"]);
        expect(state.approval).toEqual([true]);
    });

    it("a proof that does not hold runs no step", async () => {
        state.proofHolds = false;
        const result = await actions.saveTwoFactorChangesAction({ preferences: PREFERENCES, password: PROOF });
        expect(result.error).toBe("known.wrongPassword");
        expect(state.checked).toEqual([]);
    });

    it("a typed password reaches every step, and the first refusal stops the rest", async () => {
        const typed = await actions.saveTwoFactorChangesAction({ policy: POLICY, approval: false, password: "right" });
        expect(typed).toEqual({});
        expect(state.checked).toEqual(["right", "right"]);
        state.checked.length = 0;
        const refused = await actions.saveTwoFactorChangesAction({
            preferences: PREFERENCES,
            approval: true,
            password: "wrong"
        });
        expect(refused.error).toBe("Current password is incorrect.");
        expect(state.approval).toEqual([false]);
    });

    it("only the changes that were made are written", async () => {
        expect(await actions.saveTwoFactorChangesAction({ approval: true, password: PROOF })).toEqual({});
        expect(state.checked).toEqual(["stand-in:hash:1"]);
    });

    it("an unreadable body is refused before anything runs", async () => {
        expect((await actions.saveTwoFactorChangesAction({ password: 7 })).error).toBe("errors.checkForm");
        expect(state.checked).toEqual([]);
    });
});

describe("the authenticator on a proof", () => {
    it("starts through better-auth's endpoint on the stand-in and hands back the secret", async () => {
        const started = await actions.startAuthenticatorOpaqueAction(PROOF);
        expect(started).toEqual({ totpURI: "otpauth://totp/x?secret=ABC", backupCodes: ["one", "two"] });
        expect(state.enabled).toEqual([
            expect.objectContaining({ body: { password: "stand-in:hash:x", method: "totp" } })
        ]);
    });

    it("a proof that does not hold never reaches either endpoint", async () => {
        state.proofHolds = false;
        expect((await actions.startAuthenticatorOpaqueAction(PROOF)).error).toBe("known.wrongPassword");
        expect((await actions.turnOffAuthenticatorOpaqueAction(PROOF)).error).toBe("known.wrongPassword");
        expect(state.enabled).toEqual([]);
        expect(state.disabled).toEqual([]);
        const typed = await actions.turnOffAuthenticatorOpaqueAction("a typed password");
        expect(typed.error).toBe("errors.unreadable");
    });

    it("removal carries the rotated session's cookies onto the response", async () => {
        expect(await actions.turnOffAuthenticatorOpaqueAction(PROOF)).toEqual({});
        expect(state.disabled).toEqual([expect.objectContaining({ returnHeaders: true })]);
        expect(state.forwarded[0]?.get("set-cookie")).toContain("polaris.session_token=new");
    });
});
