/**
 * A sign-in that has answered some of the factors its policy asks for, and not
 * all of them, gets nothing: guardSession sends every request from that session
 * to the step-up screen. Including the request that first sees the session, and
 * including the request that loses the race to create its row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    sessionState: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    session: { deleteMany: vi.fn() }
}));
const policy = vi.hoisted(() => ({ beginSignInStepUp: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/session-device", () => ({ sessionClient: vi.fn(() => ({ label: "x" })) }));
vi.mock("@/lib/session-client-version", () => ({ followClientVersion: vi.fn() }));
vi.mock("@/lib/account-lifecycle", () => ({ restoreAccount: vi.fn() }));
vi.mock("@/lib/notifications/session-breach", () => ({ notifySessionCompromised: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn() }));
vi.mock("@/lib/session-directory", () => ({ describeOrigin: vi.fn(() => "here") }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/network-rules", () => ({
    evaluateAccountAccess: vi.fn(async () => ({ allowed: true, reason: null, country: null })),
    evaluateNetworkRules: vi.fn(async () => ({ allowed: true, reason: null, country: null }))
}));
// No access rule of the account's own, and no limit on it: this file is about factors.
vi.mock("@/lib/account-rules", () => ({
    listAccountRules: vi.fn(async () => []),
    evaluateAccountRequest: vi.fn(async () => ({ action: "allow", source: null, ruleName: null, country: null }))
}));
vi.mock("@/lib/instance-security", () => ({ getInstanceSecurity: vi.fn(async () => ({ requireSecondFactor: false })) }));
vi.mock("@/lib/notifications/session-events", () => ({ notifySessionOpened: vi.fn(), notifySessionsClosed: vi.fn() }));
vi.mock("@/lib/two-factor-policy-service", () => ({ ...policy, STEP_UP_PATH: "/oauth/step-up" }));
vi.mock("@polaris/auth", () => ({
    consumeSessionRotation: vi.fn(async () => false),
    rememberAccountDevice: vi.fn(),
    resolveSignInRules: vi.fn(async () => ({})),
    resolveEnforcedRules: vi.fn(async () => ({ allowedCidrs: [], allowedCountries: [], allowedContinents: [] })),
    takeSignInRecord: vi.fn(async () => ({ method: "password", secondFactor: "totp", authorizedBy: null }))
}));
vi.mock("@/lib/request-context", () => ({
    clientHost: vi.fn(async () => "polaris.example"),
    clientIp: vi.fn(async () => "203.0.113.7"),
    clientUserAgent: vi.fn(async () => "Mozilla/5.0"),
    clientUserAgentBrands: vi.fn(async () => null),
    clientUserAgentPlatform: vi.fn(async () => null)
}));

import { guardSession } from "@/lib/session-guard";

const input = { userId: "user-1", sessionId: "session-1", sessionCreatedAt: new Date() };

function existingState(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: "session-1",
        userId: "user-1",
        approval: "approved",
        lockedAt: null,
        lastSeenAt: new Date(),
        ip: "203.0.113.7",
        host: "polaris.example",
        pinToAddress: null,
        userAgent: "Mozilla/5.0",
        userAgentBrands: null,
        userAgentPlatform: null,
        stepUp: null,
        viewAsUserId: null,
        viewAsRoleId: null,
        viewAsAt: null,
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.user.findUnique.mockResolvedValue({
        bannedAt: null,
        disabledAt: null,
        deletionRequestedAt: null,
        twoFactorEnabled: true,
        passwordChangeRequired: false,
        security: {
            idleLockMinutes: 0,
            sessionMaxMinutes: 0,
            requireLoginApproval: false,
            bindSessionsToClient: false,
            pinSessionsToAddress: "off",
            lockdownAt: null
        }
    });
    db.sessionState.updateMany.mockResolvedValue({ count: 1 });
    db.sessionState.create.mockResolvedValue({});
});

describe("a session that still owes factors", () => {
    it("is refused on every request until they are answered", async () => {
        db.sessionState.findUnique.mockResolvedValue(existingState({ stepUp: '{"need":2}' }));
        expect(await guardSession(input)).toEqual({ ok: false, redirect: "/oauth/step-up" });
    });

    it("is served once nothing is owed", async () => {
        db.sessionState.findUnique.mockResolvedValue(existingState());
        expect((await guardSession(input)).ok).toBe(true);
    });

    it("is held from its very first request", async () => {
        db.sessionState.findUnique.mockResolvedValue(null);
        policy.beginSignInStepUp.mockResolvedValue({ stepUp: '{"need":2}', country: "US" });
        expect(await guardSession(input)).toEqual({ ok: false, redirect: "/oauth/step-up" });
        // The row is claimed owing a step before the sign-in's note is read.
        expect(db.sessionState.create.mock.calls[0]![0].data.stepUp).toBe("deciding");
        expect(db.sessionState.updateMany.mock.calls[0]![0].data.stepUp).toBe('{"need":2}');
    });

    it("lets an account with no extra policy through on its first request, as before", async () => {
        db.sessionState.findUnique.mockResolvedValue(null);
        policy.beginSignInStepUp.mockResolvedValue({ stepUp: null, country: null });
        expect((await guardSession(input)).ok).toBe(true);
    });

    it("holds the request that loses the race to create the row", async () => {
        db.sessionState.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ approval: "approved", stepUp: "deciding" })
            .mockResolvedValueOnce({ approval: "approved", stepUp: '{"need":2}' });
        db.sessionState.create.mockRejectedValue(new Error("unique"));
        expect(await guardSession(input)).toEqual({ ok: false, redirect: "/oauth/step-up" });
        // The loser never collects the sign-in's note: only the winner does.
        expect(policy.beginSignInStepUp).not.toHaveBeenCalled();
    });

    it("holds a session whose row vanished before it was decided", async () => {
        db.sessionState.findUnique.mockResolvedValue(null);
        policy.beginSignInStepUp.mockResolvedValue({ stepUp: null, country: null });
        db.sessionState.updateMany.mockResolvedValue({ count: 0 });
        expect(await guardSession(input)).toEqual({ ok: false, redirect: "/oauth/step-up" });
    });

    it("never counts a session still owing factors as the device that approves another", async () => {
        db.user.findUnique.mockResolvedValue({
            bannedAt: null,
            disabledAt: null,
            deletionRequestedAt: null,
            twoFactorEnabled: false,
            passwordChangeRequired: false,
            security: {
                idleLockMinutes: 0,
                sessionMaxMinutes: 0,
                requireLoginApproval: true,
                bindSessionsToClient: false,
                pinSessionsToAddress: "off",
                lockdownAt: null
            }
        });
        db.sessionState.findUnique.mockResolvedValue(null);
        db.sessionState.findFirst.mockResolvedValue(null);
        policy.beginSignInStepUp.mockResolvedValue({ stepUp: null, country: null });
        await guardSession(input);
        expect(db.sessionState.findFirst.mock.calls[0]![0].where).toMatchObject({ approval: "approved", stepUp: null });
    });

    it("does not read a sign-in note that ran out as a sign-in with no challenge", async () => {
        const { takeSignInRecord } = await import("@polaris/auth");
        vi.mocked(takeSignInRecord).mockResolvedValueOnce({ method: null, secondFactor: null, authorizedBy: null } as never);
        db.sessionState.findUnique.mockResolvedValue(null);
        policy.beginSignInStepUp.mockResolvedValue({ stepUp: '{"need":2}', country: "US" });
        expect(await guardSession(input)).toEqual({ ok: false, redirect: "/oauth/step-up" });
        expect(policy.beginSignInStepUp.mock.calls[0]![0].factor).toBe("code");
    });
});
