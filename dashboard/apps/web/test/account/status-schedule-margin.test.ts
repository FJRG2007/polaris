/**
 * A schedule's random margin: each end moves by up to N minutes, a different
 * amount every day, and the same amount on every read and every server.
 */

import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ZONE = "UTC";

const rule = (marginMinutes: number): core.PresenceScheduleRule => ({
    id: ID,
    presence: "invisible",
    days: core.EVERY_DAY,
    startMinute: 23 * 60,
    endMinute: 7 * 60,
    enabled: true,
    marginMinutes
});

const opening = (marginMinutes: number, day: number) =>
    core.weeklyWindow(rule(marginMinutes), ZONE, new Date(Date.UTC(2026, 9, day, 12)), 0)!.openedAt;

describe("the margin", () => {
    it("is exact at 0", () => {
        expect(opening(0, 10).toISOString()).toBe("2026-10-10T23:00:00.000Z");
    });

    it("stays within the margin either side, every day for a year", () => {
        for (let day = 1; day <= 365; day++) {
            const at = core.weeklyWindow(rule(15), ZONE, new Date(Date.UTC(2026, 0, day, 12)), 0)!;
            const exact = Date.UTC(2026, 0, day, 23);
            expect(Math.abs(at.openedAt.getTime() - exact)).toBeLessThanOrEqual(15 * 60_000);
            expect(at.closesAt.getTime()).toBeGreaterThan(at.openedAt.getTime());
        }
    });

    it("is the same on every read of the same day", () => {
        expect(opening(30, 12).getTime()).toBe(opening(30, 12).getTime());
        const morning = core.weeklyWindow(rule(30), ZONE, new Date(Date.UTC(2026, 9, 12, 1)), 0)!;
        expect(morning.openedAt.getTime()).toBe(opening(30, 12).getTime());
    });

    it("moves to a different minute on different days", () => {
        const minutes = new Set<number>();
        for (let day = 1; day <= 28; day++) minutes.add(opening(30, day).getTime() % 3_600_000);
        expect(minutes.size).toBeGreaterThan(10);
    });

    it("never lets the two ends cross on a short window", () => {
        expect(core.marginOffset({ id: ID, day: "2026-10-10", end: "open" }, 60, 3)).toBeLessThanOrEqual(1);
        expect(core.marginOffset({ id: ID, day: "2026-10-10", end: "open" }, 60, 1)).toBe(0);
    });

    it("is what decides when the status changes", () => {
        const account = { presence: "auto", presenceUntil: null, presenceSetAt: null };
        const open = opening(30, 10);
        const before = new Date(open.getTime() - 60_000);
        expect(core.presenceInForce(account, [rule(30)], ZONE, before).scheduled).toBe(
            before.getUTCHours() < 7
        );
        expect(core.presenceInForce(account, [rule(30)], ZONE, new Date(open.getTime() + 1)).scheduled).toBe(true);
        expect(core.nextPresenceChange(account, [rule(30)], ZONE, new Date(Date.UTC(2026, 9, 10, 12)))?.getTime()).toBe(
            open.getTime()
        );
    });

    it("opens on the evening before when the margin pulls a midnight start back", () => {
        const midnight: core.PresenceScheduleRule = { ...rule(15), startMinute: 0, endMinute: 9 * 60 };
        const account = { presence: "auto", presenceUntil: null, presenceSetAt: null };
        let checked = 0;
        for (let day = 1; day <= 60; day++) {
            const noon = new Date(Date.UTC(2026, 9, day, 12));
            const next = core.weeklyWindow(midnight, ZONE, noon, -1)!;
            if (next.openedAt.getUTCDate() !== noon.getUTCDate()) continue;
            checked++;
            const inside = new Date(next.openedAt.getTime() + 1);
            expect(core.openWindow([midnight], ZONE, inside)?.openedAt.getTime()).toBe(next.openedAt.getTime());
            expect(core.presenceInForce(account, [midnight], ZONE, inside).scheduled).toBe(true);
            expect(core.nextPresenceChange(account, [midnight], ZONE, noon)?.getTime()).toBe(next.openedAt.getTime());
            const before = new Date(next.openedAt.getTime() - 1);
            expect(core.presenceInForce(account, [midnight], ZONE, before).scheduled).toBe(false);
        }
        expect(checked).toBeGreaterThan(0);
    });

    it("stays open past midnight when the margin pushes a late close into the next day", () => {
        const late: core.PresenceScheduleRule = { ...rule(60), startMinute: 23 * 60 + 50, endMinute: 23 * 60 + 40 };
        let checked = 0;
        for (let day = 1; day <= 60; day++) {
            const window = core.weeklyWindow(late, ZONE, new Date(Date.UTC(2026, 9, day, 12)), 0)!;
            if (window.closesAt.getUTCDate() === new Date(Date.UTC(2026, 9, day + 1)).getUTCDate()) continue;
            checked++;
            const inside = new Date(window.closesAt.getTime() - 1);
            expect(core.openWindow([late], ZONE, inside)).not.toBeNull();
        }
        expect(checked).toBeGreaterThan(0);
    });

    it("is accepted up to the cap and defaults to exact", () => {
        const base = { presence: "busy", days: 1, startMinute: 60, endMinute: 120, enabled: true };
        expect(core.presenceScheduleSchema.parse(base).marginMinutes).toBe(0);
        expect(core.presenceScheduleSchema.safeParse({ ...base, marginMinutes: core.MAX_PRESENCE_MARGIN }).success).toBe(true);
        expect(core.presenceScheduleSchema.safeParse({ ...base, marginMinutes: core.MAX_PRESENCE_MARGIN + 1 }).success).toBe(false);
        expect(core.presenceScheduleSchema.safeParse({ ...base, marginMinutes: -1 }).success).toBe(false);
    });
});
