/**
 * The screens that embed `StepUpFields` and send the proof in their own action
 * (org delete, both successors, lockdown, lift, close account) take the step-up
 * password proven over OPAQUE as well as the old shapes (docs/chat-e2ee-phase1.md,
 * "Password flows over OPAQUE"): the proof reaches `proveStepUp` as it was sent,
 * a malformed one is refused before anything runs, and a refused proof stops the
 * act. Whether an OPAQUE proof is good is `provesPassword`'s, pinned in
 * test/chat/e2ee/opaque-password-flows.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    proved: [] as unknown[],
    refuse: false,
    acted: [] as string[]
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@polaris/auth", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/two-factor-delivery", () => ({}));
vi.mock("@/lib/chat/e2ee/opaque-password", () => ({ provesPassword: vi.fn() }));
vi.mock("@/lib/step-up", async (original) => ({
    ...(await original<typeof import("@/lib/step-up")>()),
    proveStepUp: async (_userId: string, _purpose: string, proof: unknown) => {
        calls.proved.push(proof);
        return calls.refuse ? { error: "wrong" } : {};
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "11111111-1111-4111-8111-111111111111", sessionId: "session-1" })
}));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({
    localized: async <T>(result: T) => result,
    firstIssue: (_issues: unknown, fallback: string) => ({ error: fallback })
}));
vi.mock("@/lib/account-lifecycle", () => ({
    raiseLockdown: async () => void calls.acted.push("lockdown"),
    liftLockdown: async () => void calls.acted.push("lift"),
    closeAccount: async () => void calls.acted.push("close")
}));
vi.mock("@/lib/successor-service", () => ({
    SuccessorError: class extends Error {},
    setSuccessor: async () => {
        calls.acted.push("successor");
        return { userId: "22222222-2222-4222-8222-222222222222" };
    },
    clearSuccessor: async () => void calls.acted.push("successor-cleared"),
    setOrgSuccessor: async () => {
        calls.acted.push("org-successor");
        return { userId: "22222222-2222-4222-8222-222222222222" };
    },
    clearOrgSuccessor: async () => void calls.acted.push("org-successor-cleared")
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        organization: {
            findUnique: async () => ({ ownerId: "11111111-1111-4111-8111-111111111111" })
        }
    }
}));

const lifecycle = await import("@/app/(app)/account/security/lifecycle-actions");
const successor = await import("@/app/(app)/account/security/successor-actions");
const orgSuccessor = await import("@/app/(app)/account/organizations/[slug]/settings/successor-actions");

const ORG = "33333333-3333-4333-8333-333333333333";
const OPAQUE = { proof: "opaque-password", loginId: "44444444-4444-4444-8444-444444444444", finishLoginRequest: "A".repeat(86) };
const WRONG_OPAQUE = { proof: "opaque-password", loginId: "44444444-4444-4444-8444-444444444444" };
const PASSWORD = { proof: "password", password: "correct horse battery" };

const screens: [string, (proof: unknown) => Promise<{ error?: string }>, string][] = [
    ["lockdown", (proof) => lifecycle.raiseLockdownAction({ proof }), "lockdown"],
    ["lift", (proof) => lifecycle.liftLockdownAction({ proof }), "lift"],
    ["close account", (proof) => lifecycle.closeAccountAction({ closure: "disabled", proof }), "close"],
    ["name a successor", (proof) => successor.setSuccessorAction({ identifier: "bob@example.com", proof }), "successor"],
    ["clear the successor", (proof) => successor.clearSuccessorAction({ proof }), "successor-cleared"],
    [
        "name an organization's successor",
        (proof) => orgSuccessor.setOrgSuccessorAction({ orgId: ORG, identifier: "bob@example.com", proof }),
        "org-successor"
    ],
    [
        "clear an organization's successor",
        (proof) => orgSuccessor.clearOrgSuccessorAction({ orgId: ORG, proof }),
        "org-successor-cleared"
    ]
];

beforeEach(() => {
    calls.proved.length = 0;
    calls.acted.length = 0;
    calls.refuse = false;
});

describe.each(screens)("%s", (_name, run, act) => {
    it("takes a password proven over OPAQUE, exactly as sent", async () => {
        expect(await run(OPAQUE)).toEqual({});
        expect(calls.proved).toEqual([OPAQUE]);
        expect(calls.acted).toEqual([act]);
    });

    it("still takes the old shapes, from an old client", async () => {
        expect(await run(PASSWORD)).toEqual({});
        expect(await run({ proof: "totp", code: "123456" })).toEqual({});
        expect(calls.proved).toEqual([PASSWORD, { proof: "totp", code: "123456" }]);
    });

    it("a finish-less (wrong password) proof still reaches the check, which refuses it", async () => {
        calls.refuse = true;
        expect((await run(WRONG_OPAQUE)).error).toBeTruthy();
        expect(calls.proved).toEqual([WRONG_OPAQUE]);
        expect(calls.acted).toEqual([]);
    });

    it("a malformed proof is refused before anything runs", async () => {
        for (const proof of [
            { proof: "opaque-password" },
            { proof: "opaque-password", loginId: "not-an-id", finishLoginRequest: "A".repeat(86) },
            { proof: "opaque-passwords", loginId: OPAQUE.loginId }
        ])
            expect((await run(proof)).error).toBeTruthy();
        expect(calls.proved).toEqual([]);
        expect(calls.acted).toEqual([]);
    });

    it("a password sent along with an OPAQUE proof is dropped, never checked", async () => {
        expect(await run({ ...OPAQUE, password: "sent anyway" })).toEqual({});
        expect(calls.proved).toEqual([OPAQUE]);
    });
});
