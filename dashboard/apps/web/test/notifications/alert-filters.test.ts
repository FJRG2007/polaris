/**
 * The two things that keep an alert channel quiet on purpose: a destination's
 * lowest severity, and the account's quiet hours. Both hold back only what
 * leaves Polaris - the bell is asserted untouched - and a critical event gets
 * through both unless the account said otherwise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearsMinLevel,
    heldByQuietHours,
    inQuietHours,
    parseQuietHours,
    type QuietHours
} from "@polaris/core";

const created = vi.fn(async () => {});
const sent = vi.fn(async () => ({}));
const deliveries: Array<{ kind: string; status: string; detail: string | null }> = [];
let quiet: QuietHours = { enabled: false, start: "22:00", end: "08:00", criticalBypass: true };
let floor: "info" | "warning" | "danger" = "info";

vi.mock("@polaris/db", () => ({
    prisma: {
        notificationDelivery: {
            create: async ({
                data
            }: {
                data: { kind: string; status: string; detail: string | null };
            }) => {
                deliveries.push({
                    kind: data.kind,
                    status: data.status,
                    detail: data.detail ?? null
                });
                return data;
            }
        },
        user: { findUnique: async () => null },
        userEmail: { findFirst: async () => null }
    }
}));
vi.mock("@/lib/notification-service", () => ({
    createNotification: (input: unknown) => created(input as never)
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: async () => ({}) }));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: async () => ({ timeZone: "UTC" })
}));
vi.mock("../../src/lib/notifications/preferences", () => ({
    getNotificationPreferences: async () => ({
        "deploy.failed": { inapp: true, email: false, destinations: ["d1"] },
        "deploy.succeeded": { inapp: true, email: false, destinations: ["d1"] },
        "account.security": { inapp: true, email: false, destinations: ["d1"] }
    }),
    getQuietHours: async () => quiet
}));
vi.mock("../../src/lib/notifications/destinations", () => ({
    destinationSummary: async () => ({ kind: "webhook", targetHint: "discord.com/api/..." }),
    recordDestinationResult: async () => {},
    resolveDestination: async () => ({
        id: "d1",
        kind: "webhook",
        name: "Ops",
        format: "discord",
        minLevel: floor,
        targetHint: "discord.com/api/...",
        target: "https://discord.com/api/webhooks/1/x"
    })
}));
vi.mock("../../src/lib/notifications/webhook-sender", () => ({
    sendWebhook: (...args: unknown[]) => sent(...(args as []))
}));
vi.mock("../../src/lib/notifications/outbound-hooks", () => ({
    queueOutboundHooks: async () => {}
}));
vi.mock("../../src/lib/notifications/sms-service", () => ({ sendSms: async () => ({}) }));

const { notify, QUIET_HOURS, QUIET_SEVERITY } = await import(
    "../../src/lib/notifications/dispatch"
);

/** Let the fan-out the caller does not wait for finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
    created.mockClear();
    sent.mockClear();
    deliveries.length = 0;
    quiet = { enabled: false, start: "22:00", end: "08:00", criticalBypass: true };
    floor = "info";
});

describe("severity floor", () => {
    it("ranks success with info and lets critical through", () => {
        expect(clearsMinLevel("success", "warning")).toBe(false);
        expect(clearsMinLevel("warning", "warning")).toBe(true);
        expect(clearsMinLevel("info", "danger", true)).toBe(true);
    });

    it("skips a destination whose floor the alert is under, and keeps the bell", async () => {
        floor = "danger";
        await notify({ userId: "u1", event: "deploy.succeeded", title: "Deployed" });
        await settle();
        expect(created).toHaveBeenCalledTimes(1);
        expect(sent).not.toHaveBeenCalled();
        expect(deliveries).toContainEqual({
            kind: "webhook",
            status: "skipped",
            detail: QUIET_SEVERITY
        });
    });

    it("sends what clears the floor", async () => {
        floor = "warning";
        await notify({ userId: "u1", event: "deploy.failed", title: "Failed" });
        await settle();
        expect(sent).toHaveBeenCalledTimes(1);
    });
});

describe("quiet hours", () => {
    const night: QuietHours = { enabled: true, start: "22:00", end: "08:00", criticalBypass: true };

    it("runs over midnight and treats an equal start and end as empty", () => {
        expect(inQuietHours(night, new Date("2026-10-15T23:30:00Z"), "UTC")).toBe(true);
        expect(inQuietHours(night, new Date("2026-10-15T07:59:00Z"), "UTC")).toBe(true);
        expect(inQuietHours(night, new Date("2026-10-15T08:00:00Z"), "UTC")).toBe(false);
        expect(
            inQuietHours({ ...night, end: "22:00" }, new Date("2026-10-15T22:30:00Z"), "UTC")
        ).toBe(false);
    });

    it("reads the window on the account's own clock", () => {
        // 21:30 UTC is 23:30 in Madrid in October (CEST).
        const at = new Date("2026-10-15T21:30:00Z");
        expect(inQuietHours(night, at, "UTC")).toBe(false);
        expect(inQuietHours(night, at, "Europe/Madrid")).toBe(true);
        expect(inQuietHours(night, at, "Not/AZone")).toBe(false);
    });

    it("lets critical through only while the bypass is on", () => {
        const at = new Date("2026-10-15T23:00:00Z");
        expect(heldByQuietHours(night, at, "UTC", true)).toBe(false);
        expect(heldByQuietHours({ ...night, criticalBypass: false }, at, "UTC", true)).toBe(true);
    });

    it("falls back to off for a stored value that no longer parses", () => {
        expect(parseQuietHours("{bad").enabled).toBe(false);
        expect(
            parseQuietHours(
                JSON.stringify({
                    enabled: true,
                    start: "25:00",
                    end: "08:00",
                    criticalBypass: true
                })
            ).enabled
        ).toBe(false);
    });

    it("holds the webhook back and still writes the bell", async () => {
        quiet = { enabled: true, start: "00:00", end: "23:59", criticalBypass: true };
        await notify({ userId: "u1", event: "deploy.failed", title: "Failed" });
        await settle();
        expect(created).toHaveBeenCalledTimes(1);
        expect(sent).not.toHaveBeenCalled();
        expect(deliveries).toContainEqual({
            kind: "webhook",
            status: "skipped",
            detail: QUIET_HOURS
        });
    });
});
