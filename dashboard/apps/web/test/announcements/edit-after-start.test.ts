import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    announcement: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn()
    },
    announcementDismissal: { groupBy: vi.fn() },
    notification: { groupBy: vi.fn(), deleteMany: vi.fn() },
    user: { count: vi.fn(), findFirst: vi.fn() }
}));

vi.mock("@polaris/db", () => ({ prisma: db, VISIBLE_USER: { bannedAt: null, disabledAt: null } }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn(async () => ({ inapp: "sent" })) }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: async () => ({ timeZone: "UTC" })
}));

import * as service from "@/lib/announcements/service";

const now = new Date("2026-11-17T09:00:00Z");
const ID = "0190f3c6-0000-7000-8000-000000000001";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function maintenance(overrides: Record<string, unknown> = {}) {
    const windowStart = new Date("2026-10-29T09:00:00Z");
    return {
        id: ID,
        kind: "maintenance",
        template: "maintenanceScheduled",
        localized: true,
        severity: "warning",
        title: "",
        body: "",
        details: "",
        linkUrl: null,
        linkLabel: null,
        vars: JSON.stringify({ affected: [] }),
        audience: JSON.stringify({ everyone: true, roleIds: [], groupIds: [], orgIds: [], userIds: [] }),
        sendNotice: true,
        showBanner: true,
        startsAt: new Date(windowStart.getTime() - DAY),
        endsAt: new Date(windowStart.getTime() + 4 * HOUR),
        windowStart,
        windowEnd: new Date(windowStart.getTime() + 2 * HOUR),
        leadMinutes: 24 * 60,
        notifySteps: false,
        noticedPhase: "upcoming",
        sendCursor: null,
        sendLease: null,
        reach: 15,
        createdById: null,
        createdAt: windowStart,
        updatedAt: windowStart,
        retractedAt: null,
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.user.count.mockResolvedValue(15);
    db.announcement.updateMany.mockResolvedValue({ count: 0 });
    db.notification.groupBy.mockResolvedValue([]);
    db.announcementDismissal.groupBy.mockResolvedValue([]);
});

describe("editing after it started", () => {
    it("reopens an ended maintenance window with a later end", async () => {
        const ended = maintenance();
        expect(service.editable(ended as never, now)).toBe(true);
        db.announcement.findUnique.mockResolvedValue(ended);
        db.announcement.update.mockImplementation(async ({ data }) => ({ ...ended, ...data }));
        const input = service.composeFrom(ended as never);
        const later = new Date(now.getTime() + 21 * DAY);
        const updated = await service.updateAnnouncement(
            ID,
            { ...input, windowEnd: later.toISOString() },
            now
        );
        expect(updated).not.toBeNull();
        const data = db.announcement.update.mock.calls[0]![0].data;
        expect(data.windowStart).toEqual(ended.windowStart);
        expect(data.windowEnd).toEqual(later);
        // Showing again from the window's start, and told once as what it is now.
        expect(data.startsAt).toEqual(ended.windowStart);
        expect(data.noticedPhase).toBeNull();
    });

    it("still refuses a retracted one", async () => {
        const retracted = maintenance({ retractedAt: now });
        expect(service.editable(retracted as never, now)).toBe(false);
        db.announcement.findUnique.mockResolvedValue(retracted);
        expect(
            await service.updateAnnouncement(ID, service.composeFrom(retracted as never), now)
        ).toBeNull();
    });
});

describe("history titles", () => {
    it("fills a template's placeholders instead of showing them", async () => {
        db.announcement.findMany.mockResolvedValue([maintenance()]);
        const [one] = await service.listHistory({}, { locale: "en-US", timeZone: "UTC" }, now);
        expect(one!.title).not.toContain("{start}");
        expect(one!.title).toMatch(/^Scheduled maintenance on Oct 29, 2026/);
        expect(one!.phase).toBe("ended");
        expect(one!.editable).toBe(true);
    });

    it("fills an edited title too", async () => {
        db.announcement.findMany.mockResolvedValue([
            maintenance({ localized: false, title: "Down from {start}" })
        ]);
        const [one] = await service.listHistory({}, { locale: "en-US", timeZone: "UTC" }, now);
        expect(one!.title).toBe("Down from Oct 29, 2026, 9:00 AM");
    });
});
