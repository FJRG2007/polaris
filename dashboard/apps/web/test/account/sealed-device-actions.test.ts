/**
 * Removing an encrypted-chat device from /account/sessions: only the caller's
 * own device, only a well-formed id, behind the new-device gate like every
 * other move that reaches another device, retired the same way a sign-out
 * retires it, and audited (which raises the account's security alert).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";

const calls = vi.hoisted(() => ({
    blocked: null as string | null,
    known: new Set<string>(),
    retired: [] as { userId: string; device: string }[],
    audits: [] as { action: string; targetId?: string }[]
}));

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "11111111-1111-4111-8111-111111111111", sessionId: "s1", isAdmin: false }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => calls.blocked }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/session-directory", () => ({}));
vi.mock("@/lib/extension/sessions", () => ({}));
vi.mock("@/lib/device-sessions/sessions", () => ({}));
vi.mock("@/lib/device-sessions/device-block", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async (entry: { action: string; targetId?: string }) => void calls.audits.push(entry) }));
vi.mock("@/lib/chat/e2ee/mls-delivery", () => ({
    retireDevice: async (userId: string, device: string) => void calls.retired.push({ userId, device })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        mlsDevice: {
            findUnique: async ({ where }: { where: { userId_device: { userId: string; device: string } } }) =>
                calls.known.has(`${where.userId_device.userId}/${where.userId_device.device}`) ? { device: where.userId_device.device } : null
        }
    }
}));

const { removeSealedDeviceAction } = await import("@/app/(app)/account/sessions/actions");

beforeEach(() => {
    calls.blocked = null;
    calls.known = new Set([`${ADA}/bbbbbbbb33334444`]);
    calls.retired = [];
    calls.audits = [];
});

describe("removeSealedDeviceAction", () => {
    it("retires the caller's own device and audits it", async () => {
        expect(await removeSealedDeviceAction("bbbbbbbb33334444")).toEqual({});
        expect(calls.retired).toEqual([{ userId: ADA, device: "bbbbbbbb33334444" }]);
        expect(calls.audits).toEqual([expect.objectContaining({ action: "account.chat-device.removed", targetId: "bbbbbbbb33334444" })]);
    });

    it("refuses a device the account does not have, and an id that is not one", async () => {
        for (const bad of ["cccccccc55556666", "../etc", "", 42, null, "a".repeat(65)]) {
            expect(await removeSealedDeviceAction(bad)).toEqual({ error: "errors.unknownDevice" });
        }
        expect(calls.retired).toEqual([]);
        expect(calls.audits).toEqual([]);
    });

    it("is held by the new-device gate", async () => {
        calls.blocked = "deviceGrace.blocked";
        const result = await removeSealedDeviceAction("bbbbbbbb33334444");
        expect(result.error).toBeTruthy();
        expect(calls.retired).toEqual([]);
    });
});
