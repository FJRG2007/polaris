/**
 * The sealed-chat device limit on /admin/privacy: what a stored value means,
 * and the action that stores it (administrators, 7-90, sealed chat on, audited).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ set: vi.fn(async () => undefined), audit: vi.fn(async () => undefined) }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin-1", isAdmin: true })) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: calls.audit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/setting-store", () => ({ setSetting: calls.set, getSetting: vi.fn(async () => null), getSettings: vi.fn(async () => new Map()) }));

import { inactiveDaysFrom, INACTIVE_DEVICE_DAYS_SETTING } from "@/lib/chat/e2ee/mls-delivery";
import { setSealedDeviceDaysAction } from "@/app/(app)/admin/privacy/actions";

afterEach(() => {
    delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
    calls.set.mockClear();
    calls.audit.mockClear();
});

describe("sealed device limit", () => {
    it("reads the default when unset or unreadable and clamps the rest", () => {
        expect(inactiveDaysFrom(null)).toBe(30);
        expect(inactiveDaysFrom("soon")).toBe(30);
        expect(inactiveDaysFrom("3")).toBe(7);
        expect(inactiveDaysFrom("45")).toBe(45);
        expect(inactiveDaysFrom("400")).toBe(90);
    });

    it("stores a whole number of days within 7-90 and audits it", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        expect(await setSealedDeviceDaysAction(14)).toEqual({});
        expect(calls.set).toHaveBeenCalledWith(INACTIVE_DEVICE_DAYS_SETTING, "14");
        expect(calls.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "settings.chat-sealed-device-days", metadata: { days: 14 } }));
    });

    it("refuses anything else, and everything while sealed chat is off", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        for (const bad of [6, 91, 14.5, "14", null]) expect(await setSealedDeviceDaysAction(bad)).toEqual({ error: "privacy.errors.checkSettings" });
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect(await setSealedDeviceDaysAction(14)).toEqual({ error: "privacy.errors.checkSettings" });
        expect(calls.set).not.toHaveBeenCalled();
    });
});
