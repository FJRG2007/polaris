/**
 * Reminders: planned for the owner and everybody who reads the calendar (not
 * who hid it, not a free/busy reader, nobody when its alarms are muted); fired
 * as a notification or an email; dropped when long overdue; re-planned for the
 * next occurrence; and never sent twice when two passes race.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addTeam, addUser, fake } from "../fixtures/fake-host";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import * as sharing from "@polaris-app/calendar/src/lib/sharing";
import { leaveCalendar } from "@polaris-app/calendar/src/lib/calendars";
import { fireDueReminders, planObject } from "@polaris-app/calendar/src/lib/reminders";

const ZONE = "Europe/Madrid";

describe("calendar reminders", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let carol: ReturnType<typeof addUser>;
    let dave: ReturnType<typeof addUser>;
    let erin: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        carol = addUser({ name: "Carol", email: "carol@example.test" });
        dave = addUser({ name: "Dave", email: "dave@example.test" });
        erin = addUser({ name: "Erin", email: "erin@example.test" });
        calendar = world.addCalendar(alice.id, { name: "Team", timezone: ZONE });
        world.addShare(calendar, { userId: bob.id }, "read");
        world.addShare(calendar, { userId: carol.id }, "write");
        world.addShare(calendar, { userId: dave.id }, "freebusy");
        world.addShare(calendar, { teamId: addTeam("Ops", [erin.id]) }, "read");
        db.insert("calendarDisplay", { calendarId: calendar, userId: carol.id, hidden: true });
    });

    /** A weekly event on Thursdays at 12:00 Madrid (10:00 UTC), with a notification
     *  10 minutes before and an email an hour before. */
    async function weeklyWithAlarms(): Promise<string> {
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, {
                summary: "Standup",
                start: world.at("2026-10-01T12:00:00"),
                end: world.at("2026-10-01T12:15:00"),
                rule: world.weekly(),
                alarms: [
                    {
                        action: "DISPLAY",
                        trigger: { kind: "relative", minutes: -10, related: "START" }
                    },
                    {
                        action: "EMAIL",
                        trigger: { kind: "relative", minutes: -60, related: "START" }
                    }
                ]
            }),
            floatingZone: ZONE
        });
        return objectId;
    }

    it("plans each alarm for the owner and every reader who did not hide the calendar", async () => {
        const id = await weeklyWithAlarms();
        const rows = db.rows("calendarReminder").filter((row) => row.objectId === id);
        const people = [...new Set(rows.map((row) => row.userId))].sort();
        expect(people).toEqual([alice.id, bob.id, erin.id].sort());
        expect(rows).toHaveLength(6);
        const display = rows.find((row) => row.userId === alice.id && row.action === "DISPLAY")!;
        expect(display.fireAt).toEqual(new Date("2026-10-01T09:50:00Z"));
        expect(display.occurrence).toEqual(new Date("2026-10-01T10:00:00Z"));
        const email = rows.find((row) => row.userId === alice.id && row.action === "EMAIL")!;
        expect(email.fireAt).toEqual(new Date("2026-10-01T09:00:00Z"));
    });

    it("plans nothing when the calendar's alarms are muted, and clears what was planned", async () => {
        const id = await weeklyWithAlarms();
        db.byId("calendar", calendar)!.alarmsMuted = true;
        await objects.shiftEvent(alice, {
            objectId: id,
            recurrenceKey: null,
            startDeltaMs: 0,
            endDeltaMs: 60_000,
            scope: "all",
            version: null,
            floatingZone: ZONE
        });
        expect(db.rows("calendarReminder")).toEqual([]);
    });

    it("sends a notification for a DISPLAY alarm and an email for an EMAIL alarm, then plans next week's", async () => {
        const id = await weeklyWithAlarms();
        const result = await fireDueReminders(new Date("2026-10-01T09:50:30Z"));
        expect(result).toEqual({ sent: 6, dropped: 0 });
        expect(fake.notices.map((notice) => notice.userId).sort()).toEqual(
            [alice.id, bob.id, erin.id].sort()
        );
        expect(fake.notices[0]).toMatchObject({
            event: "calendar.reminder",
            title: "Standup",
            href: `/calendar/e/${id}`
        });
        // In the event's own zone, named - not the server's.
        expect(fake.notices[0]?.body).toContain("12:00");
        expect(fake.notices[0]?.body).toContain("GMT+2");
        expect(fake.mails.map((mail) => mail.to).sort()).toEqual(
            [alice.email, bob.email, erin.email].sort()
        );
        expect(fake.mails[0]?.subject).toBe(
            world.en("reminders.mailSubject", { title: "Standup" })
        );
        expect(fake.mails[0]?.text).toContain(
            world.en("reminders.mailCalendar", { calendar: "Team" })
        );

        const next = db.rows("calendarReminder").filter((row) => row.objectId === id);
        expect(next).toHaveLength(6);
        expect(
            next.every(
                (row) => (row.occurrence as Date).toISOString() === "2026-10-08T10:00:00.000Z"
            )
        ).toBe(true);
    });

    it("drops a reminder that is hours overdue instead of sending it, and still plans the next one", async () => {
        const id = await weeklyWithAlarms();
        const result = await fireDueReminders(new Date("2026-10-01T18:00:00Z"));
        expect(result).toEqual({ sent: 0, dropped: 6 });
        expect(fake.notices).toEqual([]);
        expect(fake.mails).toEqual([]);
        expect(db.rows("calendarReminder").filter((row) => row.objectId === id)).toHaveLength(6);
    });

    it("keeps the due reminders one pass had no room for, and plans the next once they are sent", async () => {
        const id = await weeklyWithAlarms();
        const planned = db
            .rows("calendarReminder")
            .find((row) => row.objectId === id && row.action === "DISPLAY")!;
        for (let index = 0; index < 600; index += 1) {
            const userId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            world.addShare(calendar, { userId }, "read");
            db.insert("calendarReminder", { ...planned, id: undefined, userId });
        }
        const at = new Date("2026-10-01T09:50:30Z");
        const first = await fireDueReminders(at);
        expect(first.sent).toBe(500);
        expect(
            db
                .rows("calendarReminder")
                .filter((row) => row.objectId === id && (row.fireAt as Date) <= at)
        ).toHaveLength(106);
        const second = await fireDueReminders(at);
        expect(second.sent).toBe(106);
        expect(fake.notices).toHaveLength(603);
        const next = db.rows("calendarReminder").filter((row) => row.objectId === id);
        expect(
            next.filter((row) => [alice.id, bob.id, erin.id].includes(row.userId as string))
        ).toHaveLength(6);
        expect(
            next.every(
                (row) => (row.occurrence as Date).toISOString() === "2026-10-08T10:00:00.000Z"
            )
        ).toBe(true);
    });

    it("sends a claimed reminder once even when two passes run at the same time", async () => {
        await weeklyWithAlarms();
        const at = new Date("2026-10-01T09:50:30Z");
        const [first, second] = await Promise.all([fireDueReminders(at), fireDueReminders(at)]);
        expect(first.sent + second.sent).toBe(6);
        expect(fake.notices).toHaveLength(3);
        expect(fake.mails).toHaveLength(3);
    });

    it("sends nothing for an event deleted after it was planned", async () => {
        const id = await weeklyWithAlarms();
        const row = db.byId("calendarObject", id)!;
        row.deletedAt = new Date();
        const result = await fireDueReminders(new Date("2026-10-01T09:50:30Z"));
        expect(result.sent).toBe(0);
        expect(fake.notices).toEqual([]);
        expect(db.rows("calendarReminder").filter((reminder) => reminder.objectId === id)).toEqual(
            []
        );
    });

    /** A private one-off event at 12:00 Madrid on 1 October, with a notification
     *  10 minutes before and an email an hour before. */
    async function privateWithAlarms(): Promise<string> {
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, {
                summary: "Doctor",
                classification: "PRIVATE",
                start: world.at("2026-10-01T12:00:00"),
                end: world.at("2026-10-01T12:30:00"),
                alarms: [
                    {
                        action: "DISPLAY",
                        trigger: { kind: "relative", minutes: -10, related: "START" }
                    },
                    {
                        action: "EMAIL",
                        trigger: { kind: "relative", minutes: -60, related: "START" }
                    }
                ]
            }),
            floatingZone: ZONE
        });
        return objectId;
    }

    it("names a private event only to those who see it in full, and tells readers it is busy", async () => {
        db
            .rows("calendarShare")
            .find((row) => row.userId === dave.id && row.access === "freebusy")!.access = "write";
        await privateWithAlarms();
        await fireDueReminders(new Date("2026-10-01T09:50:30Z"));
        const titleOf = (userId: string) =>
            fake.notices.find((notice) => notice.userId === userId)?.title;
        expect(titleOf(alice.id)).toBe("Doctor");
        expect(titleOf(dave.id)).toBe("Doctor");
        expect(titleOf(bob.id)).toBe(world.en("published.busy"));
        expect(titleOf(erin.id)).toBe(world.en("published.busy"));
        const mailTo = (email: string) => fake.mails.find((mail) => mail.to === email)!;
        expect(mailTo(alice.email).subject).toBe(
            world.en("reminders.mailSubject", { title: "Doctor" })
        );
        expect(mailTo(bob.email).subject).toBe(
            world.en("reminders.mailSubject", { title: world.en("published.busy") })
        );
        expect(
            fake.mails
                .filter((mail) => mail.to !== alice.email && mail.to !== dave.email)
                .every((mail) => !mail.text.includes("Doctor"))
        ).toBe(true);
    });

    it("stops reminding somebody whose share is removed or cut down to free/busy", async () => {
        const id = await weeklyWithAlarms();
        const bobShare = db.rows("calendarShare").find((row) => row.userId === bob.id)!;
        await sharing.share(alice, {
            calendarId: calendar,
            target: { kind: "user", id: bob.id },
            access: "freebusy"
        });
        const reminded = () =>
            [
                ...new Set(
                    db
                        .rows("calendarReminder")
                        .filter((row) => row.objectId === id)
                        .map((row) => row.userId)
                )
            ].sort();
        expect(reminded()).toEqual([alice.id, erin.id].sort());

        await sharing.share(alice, {
            calendarId: calendar,
            target: { kind: "user", id: bob.id },
            access: "read"
        });
        await planObject(id, world.itemIn(db.byId("calendarObject", id)));
        expect(reminded()).toContain(bob.id);
        await sharing.unshare(alice, String(bobShare.id));
        expect(reminded()).toEqual([alice.id, erin.id].sort());

        const team = db.rows("calendarShare").find((row) => row.teamId)!;
        world.addShare(calendar, { userId: erin.id }, "read");
        await sharing.unshare(alice, String(team.id));
        expect(reminded()).toEqual([alice.id, erin.id].sort());
    });

    it("sends nothing to somebody cut down to free/busy after the reminder was planned", async () => {
        await weeklyWithAlarms();
        db.rows("calendarShare").find((row) => row.userId === bob.id)!.access = "freebusy";
        await fireDueReminders(new Date("2026-10-01T09:50:30Z"));
        expect(fake.notices.map((notice) => notice.userId)).not.toContain(bob.id);
        expect(fake.mails.map((mail) => mail.to)).not.toContain(bob.email);
    });

    it("forgets a calendar's reminders for whoever leaves it", async () => {
        const id = await weeklyWithAlarms();
        await leaveCalendar(bob, calendar);
        expect(
            db
                .rows("calendarReminder")
                .filter((row) => row.objectId === id)
                .map((row) => row.userId)
        ).not.toContain(bob.id);
    });

    it("clears an object's reminders when planned with nothing", async () => {
        const id = await weeklyWithAlarms();
        await planObject(id, null);
        expect(db.rows("calendarReminder")).toEqual([]);
    });
});
