/**
 * Mutes and schedules, where an alert is dispatched. A held alert still lands
 * in the bell, read, so it rings and badges nothing; mail and webhooks are
 * skipped with the reason in the delivery log. A mute that has run out and a
 * window that is open hold nothing back, and a critical event is never held.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { WEEKDAYS, type NotificationHolds, type QuietHours } from "@polaris/core";

const created = vi.fn(async (_input: unknown) => {});
const sent = vi.fn(async () => ({}));
const deliveries: Array<{ kind: string; status: string; detail: string | null }> = [];
let quiet: QuietHours = { enabled: false, start: "22:00", end: "08:00", criticalBypass: true };
let floor: "info" | "warning" | "danger" = "info";
let holds: NotificationHolds = { mutes: {}, schedules: {} };
let zone = "UTC";

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
    createNotification: (input: unknown) => created(input)
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: async () => ({}) }));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: async () => ({ timeZone: zone })
}));
vi.mock("../../src/lib/notifications/preferences", () => ({
    getNotificationPreferences: async () => ({
        "deploy.failed": { inapp: true, email: false, destinations: ["d1"] },
        "deploy.succeeded": { inapp: true, email: false, destinations: ["d1"] },
        "account.security": { inapp: true, email: false, destinations: ["d1"] }
    }),
    getQuietHours: async () => quiet,
    getNotificationHolds: async () => holds
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

const { notify, emailNotice, MUTED, OUTSIDE_SCHEDULE, QUIET_HOURS, RECORDED_QUIETLY } =
    await import("../../src/lib/notifications/dispatch");

/** Let the fan-out the caller does not wait for finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function raise(at: string, event = "deploy.failed") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    try {
        const report = await notify({ userId: "u1", event, title: "Something" });
        await settle();
        return report;
    } finally {
        vi.useRealTimers();
    }
}

function bellRow(): { read: boolean } {
    return (created.mock.calls[0] as unknown as [{ read: boolean }])[0];
}

beforeEach(() => {
    created.mockClear();
    sent.mockClear();
    deliveries.length = 0;
    quiet = { enabled: false, start: "22:00", end: "08:00", criticalBypass: true };
    floor = "info";
    holds = { mutes: {}, schedules: {} };
    zone = "UTC";
});

describe("mutes at dispatch", () => {
    it("sends as before with nothing set", async () => {
        const report = await raise("2026-10-21T12:00:00Z");
        expect(report.inapp).toBe("sent");
        expect(bellRow().read).toBe(false);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it("records a muted event read and skips the webhook", async () => {
        holds = {
            mutes: { "event:deploy.failed": { until: "2026-10-21T13:00:00.000Z" } },
            schedules: {}
        };
        const report = await raise("2026-10-21T12:00:00Z");
        expect(report.inapp).toBe("read");
        expect(bellRow().read).toBe(true);
        expect(sent).not.toHaveBeenCalled();
        expect(deliveries).toContainEqual({ kind: "webhook", status: "skipped", detail: MUTED });
        expect(deliveries).toContainEqual({
            kind: "inapp",
            status: "sent",
            detail: RECORDED_QUIETLY
        });
    });

    it("sends again once the mute has run out", async () => {
        holds = {
            mutes: { "event:deploy.failed": { until: "2026-10-21T13:00:00.000Z" } },
            schedules: {}
        };
        await raise("2026-10-21T13:00:00Z");
        expect(bellRow().read).toBe(false);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it("holds every event in a muted group", async () => {
        holds = { mutes: { "group:deploy": { until: null } }, schedules: {} };
        await raise("2026-10-21T12:00:00Z", "deploy.succeeded");
        expect(sent).not.toHaveBeenCalled();
    });

    it("never holds a critical event", async () => {
        holds = { mutes: { "group:security": { until: null } }, schedules: {} };
        await raise("2026-10-21T12:00:00Z", "account.security");
        expect(bellRow().read).toBe(false);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it("holds mail sent by name too", async () => {
        holds = { mutes: { "event:deploy.failed": { until: null } }, schedules: {} };
        const outcome = await emailNotice({ userId: "u1", event: "deploy.failed", title: "x" });
        expect(outcome).toEqual({ status: "skipped", detail: MUTED });
    });
});

describe("schedules at dispatch", () => {
    const office = { days: WEEKDAYS, startMinute: 540, endMinute: 1080 };

    it("sends inside Mon-Fri 9-18 on the account's clock and holds outside", async () => {
        holds = { mutes: {}, schedules: { "event:deploy.failed": office } };
        zone = "Europe/Madrid";
        await raise("2026-10-21T12:00:00Z"); // 14:00 in Madrid
        expect(sent).toHaveBeenCalledTimes(1);

        created.mockClear();
        sent.mockClear();
        zone = "America/New_York";
        await raise("2026-10-21T12:00:00Z"); // 08:00 in New York
        expect(sent).not.toHaveBeenCalled();
        expect(bellRow().read).toBe(true);
        expect(deliveries).toContainEqual({
            kind: "webhook",
            status: "skipped",
            detail: OUTSIDE_SCHEDULE
        });
    });

    it("keeps an overnight 22-07 window open past midnight", async () => {
        holds = {
            mutes: {},
            schedules: { "group:deploy": { days: WEEKDAYS, startMinute: 1320, endMinute: 420 } }
        };
        await raise("2026-10-22T03:00:00Z"); // Thursday 03:00, opened Wednesday
        expect(sent).toHaveBeenCalledTimes(1);
        sent.mockClear();
        await raise("2026-10-22T12:00:00Z");
        expect(sent).not.toHaveBeenCalled();
    });

    it("puts a mute's reason before quiet hours", async () => {
        quiet = { enabled: true, start: "00:00", end: "23:59", criticalBypass: true };
        holds = { mutes: { "event:deploy.failed": { until: null } }, schedules: {} };
        await raise("2026-10-21T12:00:00Z");
        expect(deliveries).toContainEqual({ kind: "webhook", status: "skipped", detail: MUTED });
        expect(deliveries).not.toContainEqual({
            kind: "webhook",
            status: "skipped",
            detail: QUIET_HOURS
        });
    });
});
