/**
 * Booking pages: the slots a visitor is offered leave out the owner's busy time
 * on the conflict calendars and the holds of other visitors; a hold becomes an
 * event only once its email is confirmed, and the confirmation checks the slot
 * again so of two visitors who raced for it the first keeps it; holds nobody
 * confirmed are swept after a day.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("./fixtures/scheduling-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { scheduling } from "./fixtures/scheduling-db";
import { addUser, fake, host } from "../fixtures/fake-host";
import * as booking from "@polaris-app/calendar/src/lib/booking";
import type { BookingPageInput } from "@polaris-app/calendar/src/lib/scheduling-schemas";

const ZONE = "Europe/Madrid";
const TUESDAY = "2026-10-06";
const day = { from: new Date(`${TUESDAY}T00:00:00+02:00`), to: new Date(`${TUESDAY}T23:59:00+02:00`) };

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
            weekly: { "0": closed, "1": closed, "2": [{ from: "09:00", to: "12:00" }], "3": closed, "4": closed, "5": closed, "6": closed },
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
        world.storeEvent(other, { summary: "Dentist", start: world.at(`${TUESDAY}T10:00:00`), end: world.at(`${TUESDAY}T11:00:00`) });
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
        return String(scheduling.rows("calendarBooking").find((row) => row.email === email)!.confirmToken);
    }

    it("offers the page's hours less the busy time of its conflict calendars", async () => {
        const slots = await booking.publicSlots(slug, day);
        expect(slots?.map((slot) => slot.start)).toEqual([madrid("09:00"), madrid("09:30"), madrid("11:00"), madrid("11:30")]);
        // Nothing about the busy event leaves in the answer.
        expect(JSON.stringify(slots)).not.toContain("Dentist");
    });

    it("stops offering a slot somebody holds, and refuses a second visitor for it", async () => {
        await request("first@outside.test", "09:00");
        expect(fake.mails.at(-1)?.text).toContain(`https://polaris.example.test/cal/booking/${confirmToken("first@outside.test")}`);
        const slots = await booking.publicSlots(slug, day);
        expect(slots?.map((slot) => slot.start)).not.toContain(madrid("09:00"));
        await expect(request("second@outside.test", "09:00")).rejects.toThrow(world.en("booking.slotTaken"));
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
        expect(fake.mails.some((mail) => mail.to === "first@outside.test" && mail.calendar?.method === "REQUEST")).toBe(true);
        expect(fake.notices).toContainEqual(expect.objectContaining({ userId: alice.id, event: "calendar.booking" }));
        // Confirming again is harmless and makes no second event.
        expect((await booking.confirmBooking(confirmToken("first@outside.test"))).status).toBe("confirmed");
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("gives a raced slot to whoever asked first, whichever confirms first", async () => {
        const start = new Date(madrid("11:00"));
        const end = new Date(madrid("11:30"));
        const base = { pageId: scheduling.rows("calendarBookingPage")[0]!.id, name: "V", start, end, timezone: ZONE };
        scheduling.insert("calendarBooking", { ...base, email: "early@outside.test", confirmToken: "e".repeat(32), manageToken: "f".repeat(32), createdAt: new Date(world.NOW.getTime() - 60_000) });
        scheduling.insert("calendarBooking", { ...base, email: "late@outside.test", confirmToken: "l".repeat(32), manageToken: "m".repeat(32), createdAt: world.NOW });

        expect((await booking.confirmBooking("l".repeat(32))).status).toBe("taken");
        expect((await booking.confirmBooking("e".repeat(32))).status).toBe("confirmed");
        expect(world.objectsIn(calendar)).toHaveLength(1);
        expect(scheduling.rows("calendarBooking").find((row) => row.email === "late@outside.test")?.status).toBe("cancelled");
    });

    it("refuses a confirmation when the owner filled the slot meanwhile", async () => {
        await request("first@outside.test", "11:30");
        world.storeEvent(calendar, { summary: "Call", start: world.at(`${TUESDAY}T11:15:00`), end: world.at(`${TUESDAY}T12:00:00`) });
        expect((await booking.confirmBooking(confirmToken("first@outside.test"))).status).toBe("taken");
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("rate limits booking by address and by email", async () => {
        await request("first@outside.test", "09:00");
        expect(fake.rateKeys).toEqual(["calendar.book:203.0.113.7", "calendar.book-email:first@outside.test"]);
        fake.rateAllowed = false;
        await expect(request("again@outside.test", "09:30")).rejects.toThrow(world.en("booking.slowDown"));
    });

    it("sweeps holds nobody confirmed within a day, and nothing else", async () => {
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
        at(25, "pending", "a");
        at(1, "pending", "b");
        at(30, "confirmed", "c");
        expect(await booking.sweepStaleBookings(world.NOW)).toBe(1);
        expect(scheduling.rows("calendarBooking").map((row) => row.email).sort()).toEqual(["b@outside.test", "c@outside.test"]);
    });

    it("cancels from the manage link, which cancels the event for the visitor", async () => {
        await request("first@outside.test", "09:00");
        const answer = await booking.confirmBooking(confirmToken("first@outside.test"));
        fake.mails.length = 0;
        await booking.cancelBooking(answer.manageToken!);
        expect(world.objectsIn(calendar)[0]?.deletedAt).toBeInstanceOf(Date);
        expect(fake.mails.some((mail) => mail.to === "first@outside.test" && mail.calendar?.method === "CANCEL")).toBe(true);
        expect(db.rows("calendarInvitation")).toHaveLength(0);
    });
});
