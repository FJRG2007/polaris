import { describe, expect, it } from "vitest";
import * as holds from "../src/schemas/notification-holds.js";
import { notificationEvent } from "../src/schemas/notifications.js";
import { WEEKDAYS, EVERY_DAY } from "../src/schemas/presence-schedule.js";

const EVENT = "deploy.failed";
const GROUP = notificationEvent(EVENT)!.group;
const CRITICAL = "account.signin";
const NOW = new Date("2026-10-21T12:00:00Z"); // a Wednesday

function withHolds(patch: Partial<holds.NotificationHolds>): holds.NotificationHolds {
    return { mutes: {}, schedules: {}, ...patch };
}

describe("hold schemas", () => {
    it("accepts an event or a group target and refuses anything else", () => {
        expect(holds.holdTargetSchema.safeParse({ kind: "event", id: EVENT }).success).toBe(true);
        expect(holds.holdTargetSchema.safeParse({ kind: "group", id: GROUP }).success).toBe(true);
        expect(holds.holdTargetSchema.safeParse({ kind: "event", id: "nope" }).success).toBe(false);
        expect(holds.holdTargetSchema.safeParse({ kind: "group", id: "nope" }).success).toBe(false);
        expect(holds.holdTargetSchema.safeParse({ kind: "user", id: EVENT }).success).toBe(false);
    });

    it("refuses a schedule with no days or minutes out of range", () => {
        const ok = { days: WEEKDAYS, startMinute: 540, endMinute: 1080 };
        expect(holds.notificationScheduleSchema.safeParse(ok).success).toBe(true);
        expect(holds.notificationScheduleSchema.safeParse({ ...ok, days: 0 }).success).toBe(false);
        expect(holds.notificationScheduleSchema.safeParse({ ...ok, days: 128 }).success).toBe(
            false
        );
        expect(holds.notificationScheduleSchema.safeParse({ ...ok, endMinute: 1440 }).success).toBe(
            false
        );
        expect(
            holds.notificationScheduleSchema.safeParse({ ...ok, startMinute: 1.5 }).success
        ).toBe(false);
    });

    it("reads a null, broken or tampered column as no holds", () => {
        expect(holds.parseNotificationHolds(null)).toEqual(holds.EMPTY_NOTIFICATION_HOLDS);
        expect(holds.parseNotificationHolds("{nope")).toEqual(holds.EMPTY_NOTIFICATION_HOLDS);
        expect(
            holds.parseNotificationHolds(
                JSON.stringify({ mutes: { "event:nope": { until: null } } })
            )
        ).toEqual(holds.EMPTY_NOTIFICATION_HOLDS);
        const saved = withHolds({ mutes: { [`group:${GROUP}`]: { until: null } } });
        expect(holds.parseNotificationHolds(JSON.stringify(saved))).toEqual(saved);
    });

    it("works out when a mute ends", () => {
        expect(holds.muteUntil("1h", NOW)).toBe("2026-10-21T13:00:00.000Z");
        expect(holds.muteUntil("1w", NOW)).toBe("2026-10-28T12:00:00.000Z");
        expect(holds.muteUntil("off", NOW)).toBeNull();
    });
});

describe("holdReason", () => {
    it("holds nothing back by default", () => {
        expect(holds.holdReason(holds.EMPTY_NOTIFICATION_HOLDS, EVENT, NOW, "UTC")).toBeNull();
    });

    it("mutes an event until the mute runs out, and not a moment after", () => {
        const until = "2026-10-21T13:00:00.000Z";
        const muted = withHolds({ mutes: { [`event:${EVENT}`]: { until } } });
        expect(holds.holdReason(muted, EVENT, NOW, "UTC")).toBe("muted");
        expect(holds.holdReason(muted, EVENT, new Date(until), "UTC")).toBeNull();
        expect(holds.holdReason(muted, "deploy.succeeded", NOW, "UTC")).toBeNull();
    });

    it("mutes a whole group, with no end when asked", () => {
        const muted = withHolds({ mutes: { [`group:${GROUP}`]: { until: null } } });
        expect(holds.holdReason(muted, EVENT, new Date("2099-01-01T00:00:00Z"), "UTC")).toBe(
            "muted"
        );
    });

    it("never holds a critical event", () => {
        const group = notificationEvent(CRITICAL)!.group;
        const muted = withHolds({
            mutes: { [`event:${CRITICAL}`]: { until: null }, [`group:${group}`]: { until: null } }
        });
        expect(holds.holdReason(muted, CRITICAL, NOW, "UTC")).toBeNull();
    });

    it("rings inside Mon-Fri 9-18 and holds outside it, on the account's clock", () => {
        const office = withHolds({
            schedules: { [`event:${EVENT}`]: { days: WEEKDAYS, startMinute: 540, endMinute: 1080 } }
        });
        // 12:00 UTC is 08:00 in New York (EDT): before the day starts there.
        expect(holds.holdReason(office, EVENT, NOW, "America/New_York")).toBe("schedule");
        expect(holds.holdReason(office, EVENT, NOW, "Europe/Madrid")).toBeNull();
        // 17:59 and 18:00 in Madrid (UTC+2 in October before the change).
        expect(
            holds.holdReason(office, EVENT, new Date("2026-10-21T15:59:00Z"), "Europe/Madrid")
        ).toBeNull();
        expect(
            holds.holdReason(office, EVENT, new Date("2026-10-21T16:00:00Z"), "Europe/Madrid")
        ).toBe("schedule");
        // Saturday noon.
        expect(holds.holdReason(office, EVENT, new Date("2026-10-24T12:00:00Z"), "UTC")).toBe(
            "schedule"
        );
    });

    it("reads an overnight window as opening on the day it names", () => {
        const fridayNight = 1 << 5;
        const night = withHolds({
            schedules: {
                [`event:${EVENT}`]: { days: fridayNight, startMinute: 1320, endMinute: 420 }
            }
        });
        // Friday 23:00, Saturday 03:00 and 06:59 are inside; Saturday 07:00 is not.
        expect(holds.holdReason(night, EVENT, new Date("2026-10-23T23:00:00Z"), "UTC")).toBeNull();
        expect(holds.holdReason(night, EVENT, new Date("2026-10-24T03:00:00Z"), "UTC")).toBeNull();
        expect(holds.holdReason(night, EVENT, new Date("2026-10-24T06:59:00Z"), "UTC")).toBeNull();
        expect(holds.holdReason(night, EVENT, new Date("2026-10-24T07:00:00Z"), "UTC")).toBe(
            "schedule"
        );
        // Friday 03:00 belongs to Thursday night, which is not chosen.
        expect(holds.holdReason(night, EVENT, new Date("2026-10-23T03:00:00Z"), "UTC")).toBe(
            "schedule"
        );
    });

    it("keeps an overnight window right across a clock change", () => {
        // Madrid leaves summer time at 03:00 on 2026-10-25: 22:00-07:00 Saturday
        // night still ends at seven on the wall clock, which is 06:00 UTC.
        const saturday = 1 << 6;
        const night = withHolds({
            schedules: { [`event:${EVENT}`]: { days: saturday, startMinute: 1320, endMinute: 420 } }
        });
        const at = (iso: string) => holds.holdReason(night, EVENT, new Date(iso), "Europe/Madrid");
        expect(at("2026-10-24T20:00:00Z")).toBeNull();
        expect(at("2026-10-25T05:59:00Z")).toBeNull();
        expect(at("2026-10-25T06:00:00Z")).toBe("schedule");
    });

    it("lets an event's own schedule replace its group's", () => {
        const both = withHolds({
            schedules: {
                [`group:${GROUP}`]: { days: WEEKDAYS, startMinute: 540, endMinute: 600 },
                [`event:${EVENT}`]: { days: EVERY_DAY, startMinute: 0, endMinute: 0 }
            }
        });
        expect(holds.holdReason(both, EVENT, NOW, "UTC")).toBeNull();
        expect(holds.holdReason(both, "deploy.succeeded", NOW, "UTC")).toBe("schedule");
    });

    it("drops mutes that have run out", () => {
        const stale = withHolds({
            mutes: {
                [`event:${EVENT}`]: { until: "2026-10-21T11:00:00.000Z" },
                [`group:${GROUP}`]: { until: null }
            }
        });
        expect(Object.keys(holds.pruneHolds(stale, NOW).mutes)).toEqual([`group:${GROUP}`]);
    });
});
