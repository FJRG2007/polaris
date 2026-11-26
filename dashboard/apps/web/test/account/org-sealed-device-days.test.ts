/**
 * An organization's sealed-chat device limit (org settings): whoever holds
 * `settings.manage` sets 7-90 days or hands it back to the instance; only a
 * value shorter than the instance's is taken, nothing while sealed chat is not
 * served, and every change is in the organization's own history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const calls = vi.hoisted(() => ({
    allowed: true,
    stored: [] as (number | null)[],
    audits: [] as { action: string; orgId?: string; metadata?: unknown }[]
}));

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "11111111-1111-4111-8111-111111111111", isAdmin: false }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async (entry: { action: string }) => void calls.audits.push(entry) }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null }));
vi.mock("@/lib/step-up", () => ({ anyStepUpProofSchema: {}, proveStepUp: async () => null }));
vi.mock("@/lib/orgs/role-service", () => ({}));
vi.mock("@/lib/orgs/invitation-service", () => ({}));
vi.mock("@/lib/orgs/policy", () => ({}));
vi.mock("@/lib/name-tags/name-tag-service", () => ({ NameTagError: class extends Error {}, saveOrganizationTag: async () => undefined }));
vi.mock("@/lib/chat/isolation", () => ({ orgChatOffered: async () => true }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/orgs/org-service", async () => {
    const { OrgError } = await import("@/lib/orgs/errors");
    return {
        OrgError,
        requireOrgPermission: async () => {
            if (!calls.allowed) throw new OrgError("forbidden");
        },
        setOrgSealedDeviceDays: async (_orgId: string, days: number | null) => void calls.stored.push(days)
    };
});

const { setOrgSealedDeviceDaysAction } = await import("@/app/(app)/account/organizations/actions");

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    calls.allowed = true;
    calls.stored = [];
    calls.audits = [];
});
afterEach(() => {
    delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
});

describe("setOrgSealedDeviceDaysAction", () => {
    it("stores a shorter limit, or none, and writes it to the organization's history", async () => {
        expect(await setOrgSealedDeviceDaysAction(ORG, 14)).toEqual({});
        expect(await setOrgSealedDeviceDaysAction(ORG, null)).toEqual({});
        expect(calls.stored).toEqual([14, null]);
        expect(calls.audits).toEqual([
            expect.objectContaining({ action: "org.sealed-device-days", orgId: ORG, metadata: { days: 14 } }),
            expect.objectContaining({ action: "org.sealed-device-days", orgId: ORG, metadata: { days: null } })
        ]);
    });

    it("only tightens the instance's limit (30 by default)", async () => {
        expect(await setOrgSealedDeviceDaysAction(ORG, 30)).toEqual({ error: "errors.sealedDevicesNotShorter" });
        expect(await setOrgSealedDeviceDaysAction(ORG, 60)).toEqual({ error: "errors.sealedDevicesNotShorter" });
        expect(calls.stored).toEqual([]);
    });

    it("refuses a value out of 7-90 or not a whole number", async () => {
        for (const bad of [6, 91, 14.5, "14", undefined]) {
            expect(await setOrgSealedDeviceDaysAction(ORG, bad)).toEqual({ error: "errors.saveThat" });
        }
        expect(calls.stored).toEqual([]);
    });

    it("refuses somebody without settings.manage, and everyone while sealed chat is not served", async () => {
        calls.allowed = false;
        expect(await setOrgSealedDeviceDaysAction(ORG, 14)).toEqual({ error: "forbidden" });
        calls.allowed = true;
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(await setOrgSealedDeviceDaysAction(ORG, 14)).toEqual({ error: "errors.sealedChatOff" });
        expect(calls.stored).toEqual([]);
        expect(calls.audits).toEqual([]);
    });
});
