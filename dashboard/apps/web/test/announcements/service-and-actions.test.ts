import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    announcement: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        create: vi.fn()
    },
    announcementDismissal: { findMany: vi.fn(), upsert: vi.fn() },
    notification: { deleteMany: vi.fn() },
    user: { count: vi.fn(), findMany: vi.fn() }
}));
const notify = vi.hoisted(() => vi.fn(async () => ({ inapp: "sent" })));
const requireAdmin = vi.hoisted(() => vi.fn());
const recordAudit = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn(async () => ({ ok: true, retryAfterMs: 0 })));

vi.mock("@polaris/db", () => ({ prisma: db, VISIBLE_USER: { bannedAt: null, disabledAt: null } }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "es-ES" }));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: async () => ({ timeZone: "Europe/Madrid" })
}));
vi.mock("@/lib/session", () => ({ requireAdmin, requireUser: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/people-search", () => ({ findAccountsAsAdmin: vi.fn(async () => []) }));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return { getTranslations: async (namespace: "announcements") => translatorFor("en-US", namespace) };
});

import * as service from "@/lib/announcements/service";
import * as actions from "@/app/(app)/admin/announcements/actions";

const now = new Date("2026-11-02T09:00:00Z");
const ID = "0190f3c6-0000-7000-8000-000000000001";

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: ID,
        kind: "announcement",
        template: "generic",
        localized: false,
        severity: "info",
        title: "Hello",
        body: "",
        linkUrl: null,
        linkLabel: null,
        vars: null,
        audience: JSON.stringify({ everyone: true, roleIds: [], groupIds: [], orgIds: [], userIds: [] }),
        sendNotice: true,
        showBanner: true,
        startsAt: new Date(now.getTime() - 60_000),
        endsAt: null,
        windowStart: null,
        windowEnd: null,
        leadMinutes: null,
        notifySteps: false,
        noticedPhase: null,
        reach: 1,
        createdById: null,
        createdAt: now,
        updatedAt: now,
        retractedAt: null,
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    db.announcementDismissal.findMany.mockResolvedValue([]);
    db.user.count.mockResolvedValue(1);
});

describe("banner visibility", () => {
    const reader = { locale: "en-US" as const, timeZone: "UTC" };

    it("shows what is live, critical first", async () => {
        db.announcement.findMany.mockResolvedValue([row(), row({ id: "b", severity: "critical", title: "Down" })]);
        const banners = await service.bannersFor("u1", reader, now);
        expect(banners.map((one) => one.title)).toEqual(["Down", "Hello"]);
        expect(banners[0]!.dismissible).toBe(false);
        expect(banners[1]!.dismissible).toBe(true);
    });

    it("hides one this reader closed, and one not meant for them", async () => {
        db.announcement.findMany.mockResolvedValue([
            row(),
            row({ id: "c", audience: JSON.stringify({ everyone: false, roleIds: [], groupIds: ["g"], orgIds: [], userIds: [] }) })
        ]);
        db.announcementDismissal.findMany.mockResolvedValue([{ announcementId: ID, phase: "live" }]);
        db.user.count.mockResolvedValue(0);
        expect(await service.bannersFor("u1", reader, now)).toEqual([]);
    });

    it("counts down to maintenance ahead", async () => {
        const windowStart = new Date(now.getTime() + 3_600_000);
        db.announcement.findMany.mockResolvedValue([
            row({ kind: "maintenance", template: "maintenanceScheduled", localized: true, windowStart, windowEnd: new Date(windowStart.getTime() + 3_600_000) })
        ]);
        const [banner] = await service.bannersFor("u1", reader, now);
        expect(banner!.phase).toBe("upcoming");
        expect(banner!.countdownTo).toBe(windowStart.toISOString());
        expect(banner!.title).toMatch(/^Scheduled maintenance on /);
    });

    it("refuses to dismiss a critical banner and records a normal one per phase", async () => {
        db.announcement.findUnique.mockResolvedValueOnce(row({ severity: "critical" }));
        expect(await service.dismissBanner("u1", ID, now)).toBe(false);
        db.announcement.findUnique.mockResolvedValueOnce(row());
        expect(await service.dismissBanner("u1", ID, now)).toBe(true);
        expect(db.announcementDismissal.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: { announcementId: ID, userId: "u1", phase: "live" } })
        );
    });
});

describe("the clock", () => {
    it("claims a phase once and tells each reader in their language", async () => {
        db.announcement.findMany.mockResolvedValue([row({ severity: "critical" })]);
        db.announcement.updateMany.mockResolvedValue({ count: 1 });
        db.user.findMany.mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }]);
        expect(await service.runAnnouncementClock(now)).toEqual({ sent: 1 });
        expect(db.announcement.updateMany).toHaveBeenCalledWith({
            where: { id: ID, noticedPhase: null, retractedAt: null },
            data: { noticedPhase: "live" }
        });
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({ event: "instance.announcement.critical", condition: `announcement:${ID}` })
        );
    });

    it("sends nothing when another runner claimed it", async () => {
        db.announcement.findMany.mockResolvedValue([row()]);
        db.announcement.updateMany.mockResolvedValue({ count: 0 });
        expect(await service.runAnnouncementClock(now)).toEqual({ sent: 0 });
        expect(notify).not.toHaveBeenCalled();
    });

    it("retracting takes the notices off every bell", async () => {
        db.announcement.updateMany.mockResolvedValue({ count: 1 });
        expect(await service.retractAnnouncement(ID, now)).toBe(true);
        expect(db.notification.deleteMany).toHaveBeenCalledWith({ where: { conditionKey: `announcement:${ID}` } });
    });
});

describe("permissions and limits", () => {
    const valid = {
        kind: "announcement",
        template: "generic",
        localized: false,
        severity: "info",
        title: "Hello",
        body: "",
        linkUrl: null,
        linkLabel: null,
        audience: { everyone: true, roleIds: [], groupIds: [], orgIds: [], userIds: [] },
        sendNotice: false,
        showBanner: true,
        startsAt: null,
        endsAt: null,
        windowStart: null,
        windowEnd: null,
        leadMinutes: null,
        affected: [],
        notifySteps: false
    };

    it("a non-administrator is turned away before anything happens", async () => {
        requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
        await expect(actions.saveAnnouncementAction(null, valid)).rejects.toThrow("NEXT_REDIRECT");
        await expect(actions.retractAnnouncementAction(ID)).rejects.toThrow("NEXT_REDIRECT");
        await expect(actions.countAudienceAction({ everyone: true })).rejects.toThrow("NEXT_REDIRECT");
        expect(db.announcement.create).not.toHaveBeenCalled();
        expect(db.announcement.updateMany).not.toHaveBeenCalled();
    });

    it("an administrator sends, audited; invalid input and the rate limit are refused", async () => {
        requireAdmin.mockResolvedValue({ id: "admin" });
        db.announcement.create.mockResolvedValue(row({ noticedPhase: null, sendNotice: false }));
        expect(await actions.saveAnnouncementAction(null, valid)).toEqual({ ok: true, id: ID });
        expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "announcement.create" }));

        expect(await actions.saveAnnouncementAction(null, { ...valid, showBanner: false })).toMatchObject({
            ok: false,
            error: "Choose a notification, a banner, or both."
        });
        rateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 120_000 });
        expect(await actions.saveAnnouncementAction(null, valid)).toMatchObject({ ok: false });
    });
});
