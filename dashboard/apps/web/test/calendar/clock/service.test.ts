/**
 * The Time area on the server: every row is its owner's and nobody else's; the
 * scheduler rings what is due once - however many passes race - moves it on,
 * and says nothing about a ring a tab already stopped or one long overdue;
 * focus cycles move through their phases; the stopwatch counts on the server's
 * clock; and the search's quick route makes exactly what the line said.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake, signIn } from "../fixtures/fake-host";
import * as actions from "@polaris-app/calendar/src/actions/clock";
import * as model from "@polaris-app/calendar/src/lib/clock/model";
import * as clock from "@polaris-app/calendar/src/lib/clock/service";
import { CalendarRefusal } from "@polaris-app/calendar/src/lib/errors";
import { parseCalendarPath } from "@polaris-app/calendar/src/screens/time";
import { GET as readTime } from "@polaris-app/calendar/src/routes/api/calendar/time/route";
import { POST as quick } from "@polaris-app/calendar/src/routes/api/calendar/time/quick/route";

const ZONE = "Europe/Madrid";
const at = (iso: string) => new Date(iso);
const alarm = (overrides: Partial<model.AlarmInput> = {}): model.AlarmInput => ({
    time: "07:00",
    days: model.EVERY_DAY,
    label: "",
    sound: "chime",
    snoozeMinutes: 10,
    enabled: true,
    ...overrides
});

describe("the Time area on the server", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;

    beforeEach(() => {
        // Thursday 1 October 2026, 08:00 UTC: 10:00 in Madrid.
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
    });

    describe("ownership", () => {
        it("lets nobody but its owner change, ring or read an alarm", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
            const [row] = db.rows("clockAlarm");
            const id = row!.id as string;
            const before = { ...row };

            await expect(clock.setAlarmEnabled(bob.id, id, false)).rejects.toBeInstanceOf(CalendarRefusal);
            await expect(clock.snoozeAlarm(bob.id, id)).rejects.toBeInstanceOf(CalendarRefusal);
            await expect(clock.skipAlarm(bob.id, id)).rejects.toBeInstanceOf(CalendarRefusal);
            await expect(clock.dismissAlarm(bob.id, id, row!.nextFireAt as Date)).rejects.toBeInstanceOf(CalendarRefusal);
            await expect(clock.saveAlarm(bob.id, id, alarm({ time: "05:00" }), ZONE)).rejects.toBeInstanceOf(CalendarRefusal);
            await clock.deleteAlarm(bob.id, id);

            const after = db.rows("clockAlarm");
            expect(after).toHaveLength(1);
            expect(after[0]!.time).toBe(before.time);
            expect(after[0]!.enabled).toBe(true);
            expect((await clock.clockSnapshot(bob.id)).alarms).toEqual([]);
            expect((await clock.clockSnapshot(alice.id)).alarms).toHaveLength(1);
        });

        it("lets nobody but its owner touch a timer", async () => {
            const id = await clock.createTimer(alice.id, { label: "", durationMs: 60_000, sound: "chime", start: true });
            await expect(clock.changeTimer(bob.id, id, "pause")).rejects.toBeInstanceOf(CalendarRefusal);
            await expect(clock.dismissTimer(bob.id, id)).rejects.toBeInstanceOf(CalendarRefusal);
            await clock.deleteTimer(bob.id, id);
            expect(db.rows("clockTimer")).toHaveLength(1);
            expect(db.rows("clockTimer")[0]!.endsAt).not.toBeNull();
        });

        it("answers an action from somebody else's id as a refusal, not a change", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
            const id = db.rows("clockAlarm")[0]!.id as string;
            signIn(bob);
            const answer = await actions.changeAlarmAction({ id, change: "enable", enabled: false });
            expect(answer.ok).toBe(false);
            expect(db.rows("clockAlarm")[0]!.enabled).toBe(true);
        });

        it("refuses the actions and the route to somebody without Calendar", async () => {
            signIn(bob);
            fake.denied.set(bob.id, new Set(["calendar.use"]));
            await expect(actions.loadClockAction()).rejects.toThrow(/NEXT_REDIRECT/);
            expect((await readTime()).status).toBe(403);
            signIn(null);
            expect((await readTime()).status).toBe(401);
        });

        it("refuses input that does not validate", async () => {
            signIn(alice);
            const answer = await actions.saveAlarmAction({ id: null, alarm: alarm({ time: "25:00" }), zone: ZONE });
            expect(answer.ok).toBe(false);
            const zone = await actions.saveAlarmAction({ id: null, alarm: alarm(), zone: "Mars/Olympus" });
            expect(zone.ok).toBe(false);
            expect(db.rows("clockAlarm")).toHaveLength(0);
        });
    });

    describe("ringing alarms", () => {
        it("rings a due alarm once, tells its owner, and moves it to its next day", async () => {
            await clock.saveAlarm(alice.id, null, alarm({ label: "Gym" }), ZONE, world.NOW);
            const due = db.rows("clockAlarm")[0]!.nextFireAt as Date;
            // 07:00 Madrid on Friday 2 October is 05:00 UTC.
            expect(due.toISOString()).toBe("2026-10-02T05:00:00.000Z");

            expect((await clock.fireDueClocks(at("2026-10-02T04:59:59Z"))).rung).toBe(0);
            expect((await clock.fireDueClocks(at("2026-10-02T05:00:07Z"))).rung).toBe(1);
            expect(fake.notices).toHaveLength(1);
            expect(fake.notices[0]).toMatchObject({
                userId: alice.id,
                event: "calendar.clock",
                title: "Gym",
                href: "/calendar/time?tab=alarms"
            });
            expect(fake.notices[0]!.body).toContain("7:00");
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-03T05:00:00.000Z");

            expect((await clock.fireDueClocks(at("2026-10-02T05:00:20Z"))).rung).toBe(0);
            expect(fake.notices).toHaveLength(1);
        });

        it("rings once however many passes race for it", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
            const now = at("2026-10-02T05:00:03Z");
            const results = await Promise.all([clock.fireDueClocks(now), clock.fireDueClocks(now), clock.fireDueClocks(now)]);
            expect(results.reduce((sum, result) => sum + result.rung, 0)).toBe(1);
            expect(fake.notices).toHaveLength(1);
        });

        it("says nothing about a ring a tab already stopped", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
            const due = db.rows("clockAlarm")[0]!.nextFireAt as Date;
            await clock.dismissAlarm(alice.id, db.rows("clockAlarm")[0]!.id as string, due, at("2026-10-02T05:00:01Z"));
            expect((await clock.fireDueClocks(at("2026-10-02T05:00:10Z"))).rung).toBe(0);
            expect(fake.notices).toHaveLength(0);
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-03T05:00:00.000Z");
        });

        it("turns a one-off off once it has rung", async () => {
            await clock.saveAlarm(alice.id, null, alarm({ days: 0, time: "11:00" }), ZONE, world.NOW);
            await clock.fireDueClocks(at("2026-10-01T09:00:05Z"));
            expect(fake.notices).toHaveLength(1);
            const [row] = db.rows("clockAlarm");
            expect(row!.enabled).toBe(false);
            expect(row!.nextFireAt).toBeNull();
        });

        it("snoozes for the alarm's own length, then goes back to its time", async () => {
            await clock.saveAlarm(alice.id, null, alarm({ snoozeMinutes: 5 }), ZONE, world.NOW);
            const id = db.rows("clockAlarm")[0]!.id as string;
            await clock.fireDueClocks(at("2026-10-02T05:00:05Z"));
            await clock.snoozeAlarm(alice.id, id, at("2026-10-02T05:00:30Z"));
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-02T05:05:30.000Z");
            await clock.fireDueClocks(at("2026-10-02T05:05:35Z"));
            expect(fake.notices).toHaveLength(2);
            expect(fake.notices[1]!.title).toBe(world.en("time.notify.snoozed"));
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-03T05:00:00.000Z");
        });

        it("skips the next ring and keeps the ones after it", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
            await clock.skipAlarm(alice.id, db.rows("clockAlarm")[0]!.id as string, world.NOW);
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-03T05:00:00.000Z");
        });

        it("moves on without telling anybody when the server slept through a ring", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, world.NOW);
            const result = await clock.fireDueClocks(at("2026-10-02T08:00:00Z"));
            expect(result).toEqual({ rung: 0, late: 1 });
            expect(fake.notices).toHaveLength(0);
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-03T05:00:00.000Z");
        });

        it("rings across the autumn clock change at the same wall time", async () => {
            await clock.saveAlarm(alice.id, null, alarm(), ZONE, at("2026-10-24T06:00:00Z"));
            // Sunday 25 October: Madrid is back on +01, so 07:00 is 06:00 UTC.
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-25T06:00:00.000Z");
            await clock.fireDueClocks(at("2026-10-25T06:00:02Z"));
            expect((db.rows("clockAlarm")[0]!.nextFireAt as Date).toISOString()).toBe("2026-10-26T06:00:00.000Z");
        });
    });

    describe("timers", () => {
        it("stores when a running timer ends, and rings it when it does", async () => {
            const id = await clock.createTimer(alice.id, { label: "Tea", durationMs: 4 * 60_000, sound: "bell", start: true }, world.NOW);
            expect((db.rows("clockTimer")[0]!.endsAt as Date).toISOString()).toBe("2026-10-01T08:04:00.000Z");
            await clock.fireDueClocks(at("2026-10-01T08:04:03Z"));
            expect(fake.notices).toEqual([
                expect.objectContaining({ userId: alice.id, title: "Tea", href: "/calendar/time?tab=timers" })
            ]);
            const row = db.rows("clockTimer").find((entry) => entry.id === id)!;
            expect(row.endsAt).toBeNull();
            expect((row.firedAt as Date).toISOString()).toBe("2026-10-01T08:04:00.000Z");
        });

        it("pauses on what is left, resumes from it, and takes a minute more", async () => {
            const id = await clock.createTimer(alice.id, { label: "", durationMs: 10 * 60_000, sound: "chime", start: true }, world.NOW);
            await clock.changeTimer(alice.id, id, "pause", at("2026-10-01T08:03:00Z"));
            expect(db.rows("clockTimer")[0]).toMatchObject({ endsAt: null, remainingMs: 7 * 60_000 });
            await clock.changeTimer(alice.id, id, "addMinute", at("2026-10-01T08:30:00Z"));
            expect(db.rows("clockTimer")[0]!.remainingMs).toBe(8 * 60_000);
            await clock.changeTimer(alice.id, id, "start", at("2026-10-01T09:00:00Z"));
            expect((db.rows("clockTimer")[0]!.endsAt as Date).toISOString()).toBe("2026-10-01T09:08:00.000Z");
            await clock.changeTimer(alice.id, id, "addMinute", at("2026-10-01T09:01:00Z"));
            expect((db.rows("clockTimer")[0]!.endsAt as Date).toISOString()).toBe("2026-10-01T09:09:00.000Z");
            await clock.changeTimer(alice.id, id, "reset", at("2026-10-01T09:02:00Z"));
            expect(db.rows("clockTimer")[0]).toMatchObject({ endsAt: null, remainingMs: null, firedAt: null });
        });

        it("lengthens a timer that has not started, and runs a rung one for a minute", async () => {
            const id = await clock.createTimer(alice.id, { label: "", durationMs: 25 * 60_000, sound: "chime", start: false }, world.NOW);
            await clock.changeTimer(alice.id, id, "addMinute", world.NOW);
            expect(db.rows("clockTimer")[0]).toMatchObject({ durationMs: 26 * 60_000, endsAt: null, remainingMs: null });
            await clock.changeTimer(alice.id, id, "start", world.NOW);
            await clock.fireDueClocks(at("2026-10-01T08:26:01Z"));
            expect(db.rows("clockTimer")[0]!.firedAt).not.toBeNull();
            await clock.changeTimer(alice.id, id, "addMinute", at("2026-10-01T08:30:00Z"));
            expect(db.rows("clockTimer")[0]).toMatchObject({ durationMs: 26 * 60_000, firedAt: null, remainingMs: null });
            expect((db.rows("clockTimer")[0]!.endsAt as Date).toISOString()).toBe("2026-10-01T08:31:00.000Z");
        });

        it("says nothing about a timer a tab already stopped", async () => {
            const id = await clock.createTimer(alice.id, { label: "", durationMs: 60_000, sound: "chime", start: true }, world.NOW);
            await clock.dismissTimer(alice.id, id, at("2026-10-01T08:01:01Z"));
            await clock.fireDueClocks(at("2026-10-01T08:01:10Z"));
            expect(fake.notices).toHaveLength(0);
            expect(db.rows("clockTimer")[0]!.firedAt).not.toBeNull();
        });

        it("holds at most its limit per person", async () => {
            for (let index = 0; index < model.MAX_TIMERS; index++)
                await clock.createTimer(alice.id, { label: "", durationMs: 60_000, sound: "chime", start: false });
            await expect(
                clock.createTimer(alice.id, { label: "", durationMs: 60_000, sound: "chime", start: false })
            ).rejects.toBeInstanceOf(CalendarRefusal);
            // Somebody else's count is their own.
            await clock.createTimer(bob.id, { label: "", durationMs: 60_000, sound: "chime", start: false });
        });
    });

    describe("focus cycles", () => {
        const config = { focus: 25, short: 5, long: 15, rounds: 2, auto: true };

        it("starts each phase by itself from the moment the last one ended", async () => {
            await clock.startFocus(alice.id, config, "", world.NOW);
            await clock.fireDueClocks(at("2026-10-01T08:25:04Z"));
            expect(fake.notices[0]).toMatchObject({ title: world.en("time.notify.phaseDone.focus") });
            let row = db.rows("clockTimer")[0]!;
            expect(model.readPomodoro(row.pomodoro as string)).toMatchObject({ phase: "short", round: 1, done: 1 });
            expect((row.endsAt as Date).toISOString()).toBe("2026-10-01T08:30:00.000Z");

            await clock.fireDueClocks(at("2026-10-01T08:30:02Z"));
            row = db.rows("clockTimer")[0]!;
            expect(model.readPomodoro(row.pomodoro as string)).toMatchObject({ phase: "focus", round: 2 });
            await clock.fireDueClocks(at("2026-10-01T08:55:02Z"));
            row = db.rows("clockTimer")[0]!;
            // The last round earns the long break.
            expect(model.readPomodoro(row.pomodoro as string)).toMatchObject({ phase: "long", done: 2 });
            expect((row.endsAt as Date).toISOString()).toBe("2026-10-01T09:10:00.000Z");
        });

        it("waits for Start between phases when it does not run by itself", async () => {
            await clock.startFocus(alice.id, { ...config, auto: false }, "", world.NOW);
            await clock.fireDueClocks(at("2026-10-01T08:25:04Z"));
            const row = db.rows("clockTimer")[0]!;
            expect(row).toMatchObject({ endsAt: null, remainingMs: 5 * 60_000 });
            expect(model.readPomodoro(row.pomodoro as string)?.phase).toBe("short");
        });

        it("skips to the next phase on request", async () => {
            await clock.startFocus(alice.id, config, "", world.NOW);
            const id = db.rows("clockTimer")[0]!.id as string;
            await clock.changeTimer(alice.id, id, "skip", at("2026-10-01T08:10:00Z"));
            const row = db.rows("clockTimer")[0]!;
            expect(model.readPomodoro(row.pomodoro as string)?.phase).toBe("short");
            expect((row.endsAt as Date).toISOString()).toBe("2026-10-01T08:15:00.000Z");
        });
    });

    describe("the stopwatch", () => {
        it("counts on the server's clock through laps, a pause and a reset", async () => {
            await clock.changeStopwatch(alice.id, "start", at("2026-10-01T08:00:00Z"));
            await clock.changeStopwatch(alice.id, "lap", at("2026-10-01T08:00:10Z"));
            await clock.changeStopwatch(alice.id, "lap", at("2026-10-01T08:00:25Z"));
            await clock.changeStopwatch(alice.id, "pause", at("2026-10-01T08:00:30Z"));
            let watch = (await clock.clockSnapshot(alice.id)).stopwatch;
            expect(watch).toEqual({ startedAt: null, elapsedMs: 30_000, laps: [10_000, 25_000] });
            await clock.changeStopwatch(alice.id, "start", at("2026-10-01T09:00:00Z"));
            watch = (await clock.clockSnapshot(alice.id)).stopwatch;
            expect(model.stopwatchElapsed(watch, Date.parse("2026-10-01T09:00:05Z"))).toBe(35_000);
            await clock.changeStopwatch(alice.id, "reset", at("2026-10-01T09:00:06Z"));
            expect((await clock.clockSnapshot(alice.id)).stopwatch).toEqual({ startedAt: null, elapsedMs: 0, laps: [] });
        });

        it("takes no lap while stopped", async () => {
            await clock.changeStopwatch(alice.id, "lap", world.NOW);
            expect((await clock.clockSnapshot(alice.id)).stopwatch.laps).toEqual([]);
        });
    });

    describe("the search's quick route", () => {
        const post = (body: unknown, site = "same-origin") =>
            quick(
                new Request("https://polaris.example.test/api/calendar/time/quick", {
                    method: "POST",
                    headers: { "content-type": "application/json", "sec-fetch-site": site },
                    body: JSON.stringify(body)
                })
            );

        it("starts what the line says, in the reader's zone", async () => {
            signIn(alice);
            expect((await post({ command: "timer 10m tea", zone: ZONE })).status).toBe(200);
            expect(db.rows("clockTimer")[0]).toMatchObject({ label: "tea", durationMs: 600_000 });
            expect((await post({ command: "alarm 7:30pm", zone: "America/New_York" })).status).toBe(200);
            expect(db.rows("clockAlarm")[0]).toMatchObject({ time: "19:30", days: 0, zone: "America/New_York" });
            expect((await post({ command: "stopwatch", zone: ZONE })).status).toBe(200);
            expect(db.rows("clockStopwatch")[0]!.startedAt).not.toBeNull();
        });

        it("cleans a typed label the way the forms do", async () => {
            signIn(alice);
            expect((await post({ command: "timer 10m tea ​time", zone: ZONE })).status).toBe(200);
            expect(db.rows("clockTimer")[0]!.label).toBe("tea time");
            expect((await post({ command: "alarm 7:30 wakeup", zone: ZONE })).status).toBe(200);
            expect(db.rows("clockAlarm")[0]!.label).toBe("wake up");
        });

        it("refuses a line it does not read, a zone nobody has, and another site", async () => {
            signIn(alice);
            expect((await post({ command: "timer soon", zone: ZONE })).status).toBe(400);
            expect((await post({ command: "timer 5m", zone: "Mars/Olympus" })).status).toBe(400);
            expect((await post({ command: "timer 5m", zone: ZONE }, "cross-site")).status).toBe(403);
            signIn(null);
            expect((await post({ command: "timer 5m", zone: ZONE })).status).toBe(401);
            expect(db.rows("clockTimer")).toHaveLength(0);
        });
    });

    it("reads the planner's hand-off from the calendar's address", () => {
        expect(parseCalendarPath(["new", "2026-10-02T14:00Z"]).newAt?.toISOString()).toBe("2026-10-02T14:00:00.000Z");
        expect(parseCalendarPath(["new", "2026-10-02T14%3A00Z"]).newAt?.toISOString()).toBe("2026-10-02T14:00:00.000Z");
        expect(parseCalendarPath(["new", "tomorrow"]).newAt).toBeNull();
        expect(parseCalendarPath(["new", "%E0%A4%A"]).newAt).toBeNull();
    });
});
