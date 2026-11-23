/**
 * Saving the instance's sign-in rules: turning the second step off is refused
 * unless the administrator accepted the risk, and recorded - who and when - when
 * they did; requiring a phone is refused while no code could confirm one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_SECURITY_DEFAULTS, type InstanceSecurityPolicy } from "@polaris/core";

const state = vi.hoisted(() => ({
    stored: null as unknown as InstanceSecurityPolicy,
    senderReady: true,
    setInstanceSecurity: vi.fn(async (_policy: unknown) => {}),
    recordAudit: vi.fn(async (_entry: unknown) => {})
}));

vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin-1", isAdmin: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: state.recordAudit }));
vi.mock("@polaris/db", () => ({ prisma: { passkey: { count: vi.fn(async () => 1) } } }));
vi.mock("@/lib/player-address-policy", () => ({ setPlayerAddressesShared: vi.fn() }));
vi.mock("@/lib/messaging/code-senders", () => ({ codeSenderReady: async () => state.senderReady }));
vi.mock("@/lib/instance-security", () => ({
    getInstanceSecurity: async () => state.stored,
    setInstanceSecurity: state.setInstanceSecurity
}));

const { saveInstanceSecurityAction } = await import("@/app/(app)/admin/security/actions");

function form(overrides: Record<string, unknown> = {}) {
    const { secondFactorRiskAccepted: _, ...policy } = state.stored;
    return { ...policy, ...overrides };
}

beforeEach(() => {
    state.stored = { ...INSTANCE_SECURITY_DEFAULTS };
    state.senderReady = true;
    state.setInstanceSecurity.mockClear();
    state.recordAudit.mockClear();
});

describe("turning the second step off", () => {
    it("is refused without the risk accepted", async () => {
        expect(await saveInstanceSecurityAction(form({ requireSecondFactor: false }))).toEqual({
            error: "security.errors.riskNotAccepted"
        });
        expect(state.setInstanceSecurity).not.toHaveBeenCalled();
    });

    it("records who accepted it and when, in the policy and the audit log", async () => {
        const result = await saveInstanceSecurityAction(form({ requireSecondFactor: false, acceptRisk: true }));
        expect(result).toEqual({ ok: "security.saved" });
        const saved = state.setInstanceSecurity.mock.calls[0]![0] as InstanceSecurityPolicy;
        expect(saved.requireSecondFactor).toBe(false);
        expect(saved.secondFactorRiskAccepted?.by).toBe("admin-1");
        expect(Number.isNaN(Date.parse(saved.secondFactorRiskAccepted!.at))).toBe(false);
        expect(state.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "admin-1",
                metadata: expect.objectContaining({ requireSecondFactor: false, secondFactorRiskAccepted: true })
            })
        );
    });

    it("never takes the acceptance from the request", async () => {
        await saveInstanceSecurityAction({
            ...form({ requireSecondFactor: false, acceptRisk: true }),
            secondFactorRiskAccepted: { by: "somebody-else", at: "2020-01-01T00:00:00.000Z" }
        });
        const saved = state.setInstanceSecurity.mock.calls[0]![0] as InstanceSecurityPolicy;
        expect(saved.secondFactorRiskAccepted?.by).toBe("admin-1");
    });

    it("keeps the acceptance on record when something else is saved while it is off", async () => {
        const accepted = { by: "admin-0", at: "2026-11-01T00:00:00.000Z" };
        state.stored = { ...INSTANCE_SECURITY_DEFAULTS, requireSecondFactor: false, secondFactorRiskAccepted: accepted };
        expect(await saveInstanceSecurityAction(form({ requireLoginApproval: true }))).toEqual({ ok: "security.saved" });
        const saved = state.setInstanceSecurity.mock.calls[0]![0] as InstanceSecurityPolicy;
        expect(saved.secondFactorRiskAccepted).toEqual(accepted);
    });

    it("clears the acceptance once the requirement is back on", async () => {
        state.stored = {
            ...INSTANCE_SECURITY_DEFAULTS,
            requireSecondFactor: false,
            secondFactorRiskAccepted: { by: "admin-0", at: "2026-11-01T00:00:00.000Z" }
        };
        await saveInstanceSecurityAction(form({ requireSecondFactor: true }));
        const saved = state.setInstanceSecurity.mock.calls[0]![0] as InstanceSecurityPolicy;
        expect(saved.secondFactorRiskAccepted).toBeNull();
    });
});

describe("requiring a phone", () => {
    it("saves and audits the requirement", async () => {
        expect(await saveInstanceSecurityAction(form({ requirePhone: true }))).toEqual({ ok: "security.saved" });
        const saved = state.setInstanceSecurity.mock.calls[0]![0] as InstanceSecurityPolicy;
        expect(saved.requirePhone).toBe(true);
        expect(state.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ requirePhone: true }) })
        );
    });

    it("is refused while no WhatsApp sender could confirm a number", async () => {
        state.senderReady = false;
        expect(await saveInstanceSecurityAction(form({ requirePhone: true }))).toEqual({
            error: "security.phone.noChannel"
        });
        expect(state.setInstanceSecurity).not.toHaveBeenCalled();
    });

    it("can still be turned off, or kept on, while the sender is down", async () => {
        state.senderReady = false;
        state.stored = { ...INSTANCE_SECURITY_DEFAULTS, requirePhone: true };
        expect(await saveInstanceSecurityAction(form({ requireLoginApproval: true }))).toEqual({ ok: "security.saved" });
        expect(await saveInstanceSecurityAction(form({ requirePhone: false }))).toEqual({ ok: "security.saved" });
    });
});
