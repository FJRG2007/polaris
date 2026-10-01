/**
 * Booking pages: the slots a visitor is offered leave out the owner's busy time
 * on the conflict calendars and the holds of other visitors; a hold becomes an
 * event only once its email is confirmed, and the confirmation checks the slot
 * again so of two visitors who raced for it the first keeps it; holds nobody
 * confirmed let go of their slot after fifteen minutes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("./fixtures/scheduling-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { scheduling } from "./fixtures/scheduling-db";
import { addUser, fake, host } from "../fixtures/fake-host";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import * as effects from "@polaris-app/calendar/src/lib/effects";
import * as booking from "@polaris-app/calendar/src/lib/booking";
import type { BookingPageInput } from "@polaris-app/calendar/src/lib/scheduling-schemas";

const ZONE = "Europe/Madrid";
const TUESDAY = "2026-10-06";
const day = {
    from: new Date(`${TUESDAY}T00:00:00+02:00`),
    to: new Date(`${TUESDAY}T23:59:00+02:00`)
};

function pageInput(calendarId: string, conflictIds: string[]): BookingPageInput {
    const closed: never[] = [];
    return {
        title: "Consultation",
        description: "",
        location: "Office",
        visibility: "public",
        calendarId,
        conflictIds,
        durationMinutes: 30,
        slotMinutes: 30,
        bufferBefore: 0,
        bufferAfter: 0,
        noticeMinutes: 0,
        maxPerDay: null,
        horizonDays: 30,
        timezone: ZONE,
        availability: {
            weekly: {
                "0": closed,
                "1": closed,
                "2": [{ from: "09:00", to: "12:00" }],
                "3": closed,
                "4": closed,
                "5": closed,
                "6": closed
            },
            overrides: {}
        },
        questions: [],
        meetingLink: false,
        enabled: true
    };
}

const madrid = (time: string) => new Date(`${TUESDAY}T${time}:00+02:00`).toISOString();

describe("booking pages", () => {
    let alice: ReturnType<typeof addUser>;
    let calendar: string;
    let slug: string;

    beforeEach(async () => {
        world.resetWorld();
        scheduling.reset();
        // The operator's switches at their defaults: booking pages on.
        Object.assign(host, { settingStore: { getSetting: async () => null } });
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
        const other = world.addCalendar(alice.id, { name: "Side job" });
        world.storeEvent(other, {
            summary: "Dentist",
            start: world.at(`${TUESDAY}T10:00:00`),
            end: world.at(`${TUESDAY}T11:00:00`)
        });
        const page = await booking.createBookingPage(alice as never, pageInput(calendar, [other]));
        slug = page.slug;
    });

    function request(email: string, time: string) {
        return booking.requestBooking({
            slug,
            start: madrid(time),
            name: "Visitor",
            email,
            note: "",
            answers: {},
            timezone: ZONE
        });
    }

    function confirmToken(email: string): string {
        return String(
            scheduling.rows("calendarBooking").find((row) => row.email === email)!.confirmToken
        );
    }

    it("offers the page's hours less the busy time of its conflict calendars", async () => {
        const slots = await booking.publicSlots(slug, day);
        expect(slots?.map((slot) => slot.start)).toEqual([
            madrid("09:00"),
            madrid("09:30"),
            madrid("11:00"),
            madrid("11:30")
        ]);
        // Nothing about the busy event leaves in the answer.
        expect(JSON.stringify(slots)).not.toContain("Dentist");
    });

    it("stops offering a slot somebody holds, and refuses a second visitor for it", async () => {
        await request("first@outside.test", "09:00");
        expect(fake.mails.at(-1)?.text).toContain(
            `https://polaris.example.test/cal/booking/${confirmToken("first@outside.test")}`
        );
        const slots = await booking.publicSlots(slug, day);
        expect(slots?.map((slot) => slot.start)).not.toContain(madrid("09:00"));
        await expect(request("second@outside.test", "09:00")).rejects.toThrow(
            world.en("booking.slotTaken")
        );
    });

    it("writes the event with the visitor invited once they confirm, and tells the owner", async () => {
        await request("first@outside.test", "09:30");
        const answer = await booking.confirmBooking(confirmToken("first@outside.test"));
        expect(answer.status).toBe("confirmed");
        const [row] = world.objectsIn(calendar);
        const event = world.eventIn(row);
        expect(event.attendees.map((attendee) => attendee.email)).toEqual(["first@outside.test"]);
        expect(event.organizer?.email).toBe(alice.email);
        expect(new Date(String(row!.startsAt)).toISOString()).toBe(madrid("09:30"));
        // The ordinary invitation path mailed the visitor the event.
        expect(
            fake.mails.some(
                (mail) => mail.to === "first@outside.test" && mail.calendar?.method === "REQUEST"
            )
        ).toBe(true);
        expect(fake.notices).toContainEqual(
            expect.objectContaining({ userId: alice.id, event: "calendar.booking" })
        );
        // Confirming again is harmless and makes no second event.
        expect((await booking.confirmBooking(confirmToken("first@outside.test"))).status).toBe(
            "confirmed"
        );
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("gives a raced slot to whoever asked first, whichever confirms first", async () => {
        const start = new Date(madrid("11:00"));
        const end = new Date(madrid("11:30"));
        const base = {
            pageId: scheduling.rows("calendarBookingPage")[0]!.id,
            name: "V",
            start,
            end,
            timezone: ZONE
        };
        scheduling.insert("calendarBooking", {
            ...base,
            email: "early@outside.test",
            confirmToken: "e".repeat(32),
            manageToken: "f".repeat(32),
            createdAt: new Date(world.NOW.getTime() - 60_000)
        });
        scheduling.insert("calendarBooking", {
            ...base,
            email: "late@outside.test",
            confirmToken: "l".repeat(32),
            manageToken: "m".repeat(32),
            createdAt: world.NOW
        });

        expect((await booking.confirmBooking("l".repeat(32))).status).toBe("taken");
        expect((await booking.confirmBooking("e".repeat(32))).status).toBe("confirmed");
        expect(world.objectsIn(calendar)).toHaveLength(1);
        expect(
            scheduling.rows("calendarBooking").find((row) => row.email === "late@outside.test")
                ?.status
        ).toBe("cancelled");
    });

    it("gives one slot to one of two visitors who ask for it at once", async () => {
        const answers = await Promise.allSettled([
            request("first@outside.test", "09:00"),
            request("second@outside.test", "09:00")
        ]);
        expect(answers.map((answer) => answer.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(answers.find((answer) => answer.status === "rejected")).toMatchObject({
            reason: { message: world.en("booking.slotTaken") }
        });
        expect(scheduling.rows("calendarBooking")).toHaveLength(1);
    });

    it("moves only one of two bookings into the same slot at once", async () => {
        const tokens: string[] = [];
        for (const [email, time] of [
            ["first@outside.test", "09:00"],
            ["second@outside.test", "11:00"]
        ] as const) {
            await request(email, time);
            tokens.push((await booking.confirmBooking(confirmToken(email))).manageToken!);
        }
        const answers = await Promise.allSettled(
            tokens.map((token) => booking.rescheduleBooking(token, madrid("09:30")))
        );
        expect(answers.map((answer) => answer.status).sort()).toEqual(["fulfilled", "rejected"]);
        const moved = scheduling
            .rows("calendarBooking")
            .filter((row) => new Date(String(row.start)).toISOString() === madrid("09:30"));
        expect(moved).toHaveLength(1);
    });

    it("lets a hold go after fifteen minutes: the slot is offered again and its link has expired", async () => {
        await request("first@outside.test", "09:00");
        const later = new Date(Date.now() + booking.HOLD_MS + 60_000);
        expect(booking.HOLD_MS).toBe(900_000);
        expect((await booking.publicSlots(slug, day, later))?.map((slot) => slot.start)).toContain(
            madrid("09:00")
        );
        expect(
            (await booking.confirmBooking(confirmToken("first@outside.test"), later)).status
        ).toBe("expired");
    });

    it("refuses a confirmation when the owner filled the slot meanwhile", async () => {
        await request("first@outside.test", "11:30");
        world.storeEvent(calendar, {
            summary: "Call",
            start: world.at(`${TUESDAY}T11:15:00`),
            end: world.at(`${TUESDAY}T12:00:00`)
        });
        expect((await booking.confirmBooking(confirmToken("first@outside.test"))).status).toBe(
            "taken"
        );
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("rate limits booking by address and by email", async () => {
        await request("first@outside.test", "09:00");
        expect(fake.rateKeys).toEqual([
            "calendar.book:203.0.113.7",
            "calendar.book-email:first@outside.test"
        ]);
        fake.rateAllowed = false;
        await expect(request("again@outside.test", "09:30")).rejects.toThrow(
            world.en("booking.slowDown")
        );
    });

    it("sweeps holds nobody confirmed within fifteen minutes, and nothing else", async () => {
        const pageId = scheduling.rows("calendarBookingPage")[0]!.id;
        const at = (hoursAgo: number, status: string, token: string) =>
            scheduling.insert("calendarBooking", {
                pageId,
                name: "V",
                email: `${token}@outside.test`,
                start: new Date(madrid("09:00")),
                end: new Date(madrid("09:30")),
                status,
                confirmToken: token.repeat(24),
                manageToken: token.toUpperCase().repeat(24),
                createdAt: new Date(world.NOW.getTime() - hoursAgo * 3_600_000)
            });
        at(2, "pending", "a");
        at(0.1, "pending", "b");
        at(30, "confirmed", "c");
        expect(await booking.sweepStaleBookings(world.NOW)).toBe(1);
        expect(
            scheduling
                .rows("calendarBooking")
                .map((row) => row.email)
                .sort()
        ).toEqual(["b@outside.test", "c@outside.test"]);
    });

    it("cancels from the manage link, which cancels the event for the visitor", async () => {
        await request("first@outside.test", "09:00");
        const answer = await booking.confirmBooking(confirmToken("first@outside.test"));
        fake.mails.length = 0;
        await booking.cancelBooking(answer.manageToken!);
        expect(world.objectsIn(calendar)[0]?.deletedAt).toBeInstanceOf(Date);
        expect(
            fake.mails.some(
                (mail) => mail.to === "first@outside.test" && mail.calendar?.method === "CANCEL"
            )
        ).toBe(true);
        expect(db.rows("calendarInvitation")).toHaveLength(0);
    });

    async function confirmed(email: string, time: string) {
        await request(email, time);
        const answer = await booking.confirmBooking(confirmToken(email));
        const row = scheduling.rows("calendarBooking").find((entry) => entry.email === email)!;
        return { answer, row, object: db.byId("calendarObject", String(row.objectId))! };
    }

    it("counts the minimum notice from when the slot was held, so a hold near the boundary still confirms", async () => {
        scheduling.rows("calendarBookingPage")[0]!.noticeMinutes = 60;
        vi.setSystemTime(new Date(madrid("08:00")));
        await request("first@outside.test", "09:00");
        const answer = await booking.confirmBooking(
            confirmToken("first@outside.test"),
            new Date(madrid("08:05"))
        );
        expect(answer.status).toBe("confirmed");
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("keeps at most three open holds per visitor on a page, by address and by email, and expired ones do not count", async () => {
        for (const time of ["09:00", "09:30", "11:00"]) await request("first@outside.test", time);
        await expect(request("first@outside.test", "11:30")).rejects.toThrow(
            world.en("booking.tooManyHolds")
        );
        await expect(request("other@outside.test", "11:30")).rejects.toThrow(
            world.en("booking.tooManyHolds")
        );
        const stored = scheduling.rows("calendarBooking");
        expect(stored).toHaveLength(3);
        expect(
            stored.every(
                (row) =>
                    typeof row.requester === "string" &&
                    row.requester.length === 64 &&
                    !String(row.requester).includes("203.0.113.7")
            )
        ).toBe(true);
        vi.setSystemTime(new Date(Date.now() + booking.HOLD_MS + 60_000));
        await request("other@outside.test", "11:30");
        expect(scheduling.rows("calendarBooking")).toHaveLength(4);
    });

    it("counts an email against its hourly limit only once the page is found", async () => {
        await expect(
            booking.requestBooking({
                slug: "no-such-page",
                start: madrid("09:00"),
                name: "Visitor",
                email: "victim@outside.test",
                note: "",
                answers: {},
                timezone: ZONE
            })
        ).rejects.toThrow(world.en("booking.pageGone"));
        expect(fake.rateKeys).toEqual(["calendar.book:203.0.113.7"]);
    });

    it("finds a page whatever the case of its address", async () => {
        expect(await booking.publicBookingPage(slug.toUpperCase())).not.toBeNull();
        expect(await booking.publicSlots(slug.toUpperCase(), day)).not.toBeNull();
    });

    it("cancels the booking and tells the visitor, in their language, when the owner deletes its event", async () => {
        fake.requestLocale = "es-ES";
        const { row, object } = await confirmed("first@outside.test", "09:00");
        fake.mails.length = 0;
        await objects.deleteEvent(alice as never, {
            objectId: String(object.id),
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        expect(row.status).toBe("cancelled");
        expect(fake.mails.find((mail) => mail.subject === "Cancelada: Consultation")?.to).toBe(
            "first@outside.test"
        );
        expect((await booking.publicSlots(slug, day))?.map((slot) => slot.start)).toContain(
            madrid("09:00")
        );
    });

    it("moves the booking with its event", async () => {
        const { row, object } = await confirmed("first@outside.test", "09:30");
        await objects.shiftEvent(alice as never, {
            objectId: String(object.id),
            recurrenceKey: null,
            startDeltaMs: 3_600_000,
            endDeltaMs: 3_600_000,
            scope: "all",
            version: null,
            floatingZone: ZONE
        });
        expect(new Date(String(row.start)).toISOString()).toBe(madrid("10:30"));
        expect(new Date(String(row.end)).toISOString()).toBe(madrid("11:00"));
        expect(row.status).toBe("confirmed");
    });

    it("cancels the booking when the owner declines its event or a pull removes it", async () => {
        const first = await confirmed("first@outside.test", "09:00");
        const item = world.itemIn(first.object);
        if (item.component !== "VEVENT" || !item.master) throw new Error("not an event");
        const declined = {
            ...item,
            master: {
                ...item.master,
                attendees: [
                    ...item.master.attendees,
                    {
                        email: alice.email,
                        name: "Alice",
                        role: "REQ-PARTICIPANT",
                        partstat: "DECLINED",
                        rsvp: false,
                        type: "INDIVIDUAL"
                    } as const
                ]
            }
        };
        await objects.writeItem(calendar, first.object as never, declined, {
            actor: null,
            floatingZone: ZONE,
            fromProvider: true
        });
        expect(first.row.status).toBe("cancelled");

        const second = await confirmed("second@outside.test", "11:00");
        fake.mails.length = 0;
        await effects.afterObjectChange({
            objectId: String(second.object.id),
            calendarId: calendar,
            before: world.itemIn(second.object),
            after: null,
            context: { actor: null, floatingZone: ZONE, fromProvider: true }
        });
        expect(second.row.status).toBe("cancelled");
        expect(
            fake.mails.some(
                (mail) =>
                    mail.to === "second@outside.test" &&
                    mail.subject ===
                        world.en("booking.mail.cancelledSubject", { title: "Consultation" })
            )
        ).toBe(true);
    });

    it("lists somebody's pages only when they publish one, and never names an account that does not", async () => {
        const bob = addUser({ name: "Bob", email: "bob@example.test" });
        expect(await booking.publicPagesOf(bob.id)).toBeNull();
        const found = await booking.publicPagesOf(alice.id);
        expect(found?.ownerName).toBe("Alice");
        expect(found?.pages.map((page) => page.slug)).toEqual([slug]);
        scheduling.rows("calendarBookingPage")[0]!.visibility = "link";
        expect(await booking.publicPagesOf(alice.id)).toBeNull();
    });

    it("takes no bookings on a page whose calendar is in the trash", async () => {
        db.byId("calendar", calendar)!.trashedAt = new Date();
        expect(await booking.publicBookingPage(slug)).toBeNull();
        expect(await booking.publicSlots(slug, day)).toBeNull();
        expect(await booking.publicPagesOf(alice.id)).toBeNull();
        await expect(request("first@outside.test", "09:00")).rejects.toThrow(
            world.en("booking.pageGone")
        );
    });
});
