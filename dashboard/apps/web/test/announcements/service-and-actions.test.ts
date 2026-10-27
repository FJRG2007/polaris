import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    announcement: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
        findFirst: vi.fn()
    },
    announcementDismissal: { findMany: vi.fn(), upsert: vi.fn() },
    notification: { deleteMany: vi.fn() },
    user: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() }
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
    return {
        getTranslations: async (namespace: "announcements") => translatorFor("en-US", namespace)
    };
});

import * as service from "@/lib/announcements/service";
import { subscribeNotices, type NoticeChange } from "@/lib/shell-notices-live";
import * as actions from "@/app/(app)/admin/announcements/actions";

const now = new Date("2026-11-02T09:00:00Z");
const ID = "0190f3c6-0000-7000-8000-000000000001";
const MY_GROUP = "0190f3c6-0000-7000-8000-0000000000a1";
const OTHER_GROUP = "0190f3c6-0000-7000-8000-0000000000a2";

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
        audience: JSON.stringify({
            everyone: true,
            roleIds: [],
            groupIds: [],
            orgIds: [],
            userIds: []
        }),
        sendNotice: true,
        showBanner: true,
        startsAt: new Date(now.getTime() - 60_000),
        endsAt: null,
        windowStart: null,
        windowEnd: null,
        leadMinutes: null,
        notifySteps: false,
        noticedPhase: null,
        sendCursor: null,
        sendLease: null,
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
    db.user.findFirst.mockResolvedValue({ roles: [], groups: [], orgMemberships: [] });
});

describe("banner visibility", () => {
    const reader = { locale: "en-US" as const, timeZone: "UTC" };

    it("shows what is live, critical first", async () => {
        db.announcement.findMany.mockResolvedValue([
            row(),
            row({ id: "b", severity: "critical", title: "Down" })
        ]);
        const banners = await service.bannersFor("u1", reader, now);
        expect(banners.map((one) => one.title)).toEqual(["Down", "Hello"]);
        expect(banners[0]!.dismissible).toBe(false);
        expect(banners[1]!.dismissible).toBe(true);
    });

    it("hides one this reader closed, and one not meant for them", async () => {
        db.announcement.findMany.mockResolvedValue([
            row(),
            row({
                id: "c",
                audience: JSON.stringify({
                    everyone: false,
                    roleIds: [],
                    groupIds: ["g"],
                    orgIds: [],
                    userIds: []
                })
            })
        ]);
        db.announcementDismissal.findMany.mockResolvedValue([
            { announcementId: ID, phase: "live" }
        ]);
        expect(await service.bannersFor("u1", reader, now)).toEqual([]);
    });

    it("matches every targeted banner against one read of the reader's memberships", async () => {
        const groupOnly = (id: string, groupId: string) =>
            row({
                id,
                title: id,
                audience: JSON.stringify({
                    everyone: false,
                    roleIds: [],
                    groupIds: [groupId],
                    orgIds: [],
                    userIds: []
                })
            });
        db.announcement.findMany.mockResolvedValue([
            ...Array.from({ length: 30 }, (_, at) => groupOnly(`other-${at}`, OTHER_GROUP)),
            groupOnly("mine", MY_GROUP)
        ]);
        db.user.findFirst.mockResolvedValue({
            roles: [],
            groups: [{ groupId: MY_GROUP }],
            orgMemberships: []
        });
        const banners = await service.bannersFor("u1", reader, now);
        expect(banners.map((one) => one.id)).toEqual(["mine"]);
        expect(db.user.findFirst).toHaveBeenCalledTimes(1);
        expect(db.user.count).not.toHaveBeenCalled();
    });

    it("counts down to maintenance ahead", async () => {
        const windowStart = new Date(now.getTime() + 3_600_000);
        db.announcement.findMany.mockResolvedValue([
            row({
                kind: "maintenance",
                template: "maintenanceScheduled",
                localized: true,
                windowStart,
                windowEnd: new Date(windowStart.getTime() + 3_600_000)
            })
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
            data: { noticedPhase: "live", sendCursor: null, sendLease: expect.any(Date) }
        });
        expect(db.announcement.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { sendCursor: "u2", sendLease: expect.any(Date) } })
        );
        expect(db.announcement.updateMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: { sendCursor: null, sendLease: null } })
        );
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "instance.announcement.critical",
                condition: `announcement:${ID}`
            })
        );
    });

    it("sends nothing when another runner claimed it", async () => {
        db.announcement.findMany.mockResolvedValue([row()]);
        db.announcement.updateMany.mockResolvedValue({ count: 0 });
        expect(await service.runAnnouncementClock(now)).toEqual({ sent: 0 });
        expect(notify).not.toHaveBeenCalled();
    });

    it("only reads rows that may still owe a notice, and pages through all of them", async () => {
        const page = Array.from({ length: 50 }, (_, at) =>
            row({ id: `r${at}`, noticedPhase: "live" })
        );
        db.announcement.findMany.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
        await service.runAnnouncementClock(now);
        const first = db.announcement.findMany.mock.calls[0]![0];
        expect(first.where.AND[1]).toEqual({
            OR: [
                { noticedPhase: null },
                { notifySteps: true },
                { sendLease: { lte: new Date(now.getTime() - 5 * 60_000) } }
            ]
        });
        expect(db.announcement.findMany.mock.calls[1]![0]).toMatchObject({
            cursor: { id: "r49" },
            skip: 1
        });
    });

    it("resumes a send that died partway after the last reader it reached", async () => {
        const lease = new Date(now.getTime() - 10 * 60_000);
        db.announcement.findMany.mockResolvedValue([
            row({ noticedPhase: "live", sendLease: lease, sendCursor: "u1" })
        ]);
        db.announcement.updateMany.mockResolvedValue({ count: 1 });
        db.user.findMany.mockResolvedValueOnce([{ id: "u2" }]);
        await service.runAnnouncementClock(now);
        expect(db.announcement.updateMany).toHaveBeenCalledWith({
            where: { id: ID, noticedPhase: "live", sendLease: lease, retractedAt: null },
            data: { sendLease: expect.any(Date) }
        });
        expect(db.user.findMany.mock.calls[0]![0].where).toEqual({
            AND: [expect.anything(), { id: { gt: "u1" } }]
        });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "u2" }));
    });

    it("leaves a send that is still making progress to its runner", async () => {
        db.announcement.findMany.mockResolvedValue([
            row({ noticedPhase: "live", sendLease: new Date(now.getTime() - 60_000) })
        ]);
        await service.runAnnouncementClock(now);
        expect(db.announcement.updateMany).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it("a retraction during a send stops it and takes back what went out after", async () => {
        db.announcement.findMany.mockResolvedValue([row()]);
        db.announcement.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        db.announcement.findUnique.mockResolvedValue({ retractedAt: now });
        db.user.findMany.mockResolvedValueOnce(
            Array.from({ length: 200 }, (_, at) => ({ id: `u${String(at).padStart(3, "0")}` }))
        );
        await service.runAnnouncementClock(now);
        expect(db.user.findMany).toHaveBeenCalledTimes(1);
        expect(db.notification.deleteMany).toHaveBeenCalledWith({
            where: { conditionKey: `announcement:${ID}` }
        });
    });

    it("retracting takes the notices off every bell", async () => {
        db.announcement.updateMany.mockResolvedValue({ count: 1 });
        expect(await service.retractAnnouncement(ID, now)).toBe(true);
        expect(db.notification.deleteMany).toHaveBeenCalledWith({
            where: { conditionKey: `announcement:${ID}` }
        });
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
        await expect(actions.countAudienceAction({ everyone: true })).rejects.toThrow(
            "NEXT_REDIRECT"
        );
        expect(db.announcement.create).not.toHaveBeenCalled();
        expect(db.announcement.updateMany).not.toHaveBeenCalled();
    });

    it("an administrator sends, audited; invalid input and the rate limit are refused", async () => {
        requireAdmin.mockResolvedValue({ id: "admin" });
        db.announcement.create.mockResolvedValue(row({ noticedPhase: null, sendNotice: false }));
        expect(await actions.saveAnnouncementAction(null, valid)).toEqual({ ok: true, id: ID });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "announcement.create" })
        );

        expect(
            await actions.saveAnnouncementAction(null, { ...valid, showBanner: false })
        ).toMatchObject({
            ok: false,
            error: "Choose a notification, a banner, or both."
        });
        rateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 120_000 });
        expect(await actions.saveAnnouncementAction(null, valid)).toMatchObject({ ok: false });
    });
});

describe("telling the open tabs", () => {
    const heard: NoticeChange[] = [];
    let stop: () => void = () => undefined;
    beforeEach(() => {
        heard.length = 0;
        stop = subscribeNotices((change) => heard.push(change));
    });
    const audiences = () =>
        heard.map((change) => (typeof change.reach === "object" ? change.reach.audiences : change.reach));
    const ana = { everyone: false, roleIds: [], groupIds: [], orgIds: [], userIds: ["0190f3c6-0000-7000-8000-0000000000b1"] };
    const group = { everyone: false, roleIds: [], groupIds: [MY_GROUP], orgIds: [], userIds: [] };

    it("a published one goes to its audience", async () => {
        db.announcement.create.mockResolvedValue(row({ audience: JSON.stringify(group), sendNotice: false }));
        await service.createAnnouncement("admin", { ...service.composeFrom(row({ audience: JSON.stringify(group) })) }, now);
        stop();
        expect(heard.every((change) => change.topic === "announcements")).toBe(true);
        expect(audiences()[0]).toEqual([group]);
    });

    it("an edit goes to the audience it had and the one it has", async () => {
        const later = { startsAt: new Date(now.getTime() + 3_600_000) };
        db.announcement.findUnique.mockResolvedValue(row({ ...later, audience: JSON.stringify(ana) }));
        db.announcement.update.mockResolvedValue(row({ ...later, audience: JSON.stringify(group), sendNotice: false }));
        const input = service.composeFrom(row({ ...later, audience: JSON.stringify(group) }));
        expect(await service.updateAnnouncement(ID, input, now)).not.toBeNull();
        stop();
        expect(audiences()[0]).toEqual([ana, group]);
    });

    it("a withdrawn one goes to its audience", async () => {
        db.announcement.updateMany.mockResolvedValue({ count: 1 });
        db.announcement.findUnique.mockResolvedValue({ audience: JSON.stringify(group) });
        await service.retractAnnouncement(ID, now);
        stop();
        expect(audiences()).toEqual([[group]]);
    });

    it("an ended one goes to its audience", async () => {
        db.announcement.findUnique.mockResolvedValue(row({ audience: JSON.stringify(group) }));
        expect(await service.endAnnouncement(ID, now)).toBe("ended");
        stop();
        expect(audiences()).toEqual([[group]]);
    });

    it("a closed one goes only to the reader who closed it", async () => {
        db.announcement.findUnique.mockResolvedValue(row());
        expect(await service.dismissBanner("u1", ID, now)).toBe(true);
        stop();
        expect(audiences()).toEqual([[{ ...ana, userIds: ["u1"] }]]);
    });

    it("says when the next boundary is, counting one not up yet", async () => {
        const windowStart = new Date(now.getTime() + 3_600_000);
        db.announcement.findMany.mockResolvedValue([
            row({
                kind: "maintenance",
                template: "maintenanceScheduled",
                localized: true,
                windowStart,
                windowEnd: new Date(windowStart.getTime() + 3_600_000)
            })
        ]);
        db.announcement.findFirst.mockResolvedValue({ startsAt: new Date(now.getTime() + 600_000) });
        const reader = { locale: "en-US" as const, timeZone: "UTC" };
        const state = await service.bannerStateFor("u1", reader, now);
        stop();
        expect(state.banners).toHaveLength(1);
        expect(state.nextChangeInMs).toBe(600_000);
        db.announcement.findFirst.mockResolvedValue(null);
        expect((await service.bannerStateFor("u1", reader, now)).nextChangeInMs).toBe(3_600_000);
    });
});
