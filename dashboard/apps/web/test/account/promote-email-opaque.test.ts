/**
 * Making an alternate address the primary with the password proven over OPAQUE
 * (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE"): the proof is
 * finished by `provesPassword` on this session, the swap runs only when it
 * holds, and the old action keeps taking the password for old clients.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    proofs: [] as unknown[],
    proves: true,
    promoted: [] as unknown[],
    audits: [] as unknown[]
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "11111111-1111-4111-8111-111111111111", sessionId: "session-1" })
}));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({ localized: async <T>(result: T) => result }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async (entry: unknown) => void calls.audits.push(entry) }));
vi.mock("@/lib/chat/e2ee/opaque-password", () => ({
    provesPassword: async (_userId: string, proof: unknown) => {
        calls.proofs.push(proof);
        return calls.proves;
    }
}));
vi.mock("@polaris/auth", async (original) => ({
    ...(await original<typeof import("@polaris/auth")>()),
    promoteUserEmail: async (...args: unknown[]) => {
        calls.promoted.push(args.slice(1));
        return {};
    }
}));

const { promoteEmailOpaqueAction, promoteEmailAction } = await import("@/app/(app)/account/actions");

const USER = "11111111-1111-4111-8111-111111111111";
const EMAIL_ID = "55555555-5555-4555-8555-555555555555";
const PROOF = { loginId: "44444444-4444-4444-8444-444444444444", finishLoginRequest: "A".repeat(86) };

beforeEach(() => {
    calls.proofs.length = 0;
    calls.promoted.length = 0;
    calls.audits.length = 0;
    calls.proves = true;
});

describe("promoting an address over OPAQUE", () => {
    it("swaps on a proof that holds, with no password anywhere", async () => {
        expect(await promoteEmailOpaqueAction(EMAIL_ID, PROOF)).toEqual({});
        expect(calls.proofs).toEqual([PROOF]);
        expect(calls.promoted).toEqual([[USER, EMAIL_ID, { proven: true }]]);
        expect(calls.audits).toMatchObject([{ action: "account.email.primary-changed", metadata: { method: "opaque" } }]);
    });

    it("a wrong password (no finish) or a refused proof changes nothing", async () => {
        calls.proves = false;
        expect((await promoteEmailOpaqueAction(EMAIL_ID, { loginId: PROOF.loginId })).error).toBeTruthy();
        expect((await promoteEmailOpaqueAction(EMAIL_ID, PROOF)).error).toBeTruthy();
        expect(calls.promoted).toEqual([]);
        expect(calls.audits).toEqual([]);
    });

    it("a malformed proof or address is refused before any proof is spent", async () => {
        expect((await promoteEmailOpaqueAction("not-an-id", PROOF)).error).toBeTruthy();
        expect((await promoteEmailOpaqueAction(EMAIL_ID, { loginId: "x" })).error).toBeTruthy();
        expect((await promoteEmailOpaqueAction(EMAIL_ID, "correct horse battery")).error).toBeTruthy();
        expect(calls.proofs).toEqual([]);
        expect(calls.promoted).toEqual([]);
    });

    it("the old action still takes the password, for old clients", async () => {
        expect(await promoteEmailAction(EMAIL_ID, "correct horse battery")).toEqual({});
        expect(calls.promoted).toEqual([[USER, EMAIL_ID, "correct horse battery"]]);
        expect(calls.proofs).toEqual([]);
    });
});
