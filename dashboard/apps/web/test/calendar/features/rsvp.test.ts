/**
 * Answering an invitation from its link: the answer lands on the organizer's
 * copy and the invitation row, the organizer hears about it, one occurrence of
 * a series can be answered alone, and a caller asking too often is refused.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import * as rsvp from "@polaris-app/calendar/src/lib/rsvp";
import * as objects from "@polaris-app/calendar/src/lib/objects";

const ZONE = "Europe/Madrid";
const GUEST = "guest@outside.test";

describe("answering an invitation from its link", () => {
    let alice: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
    });

    async function invite(fields: Record<string, unknown> = {}): Promise<{ objectId: string; token: string }> {
        const { objectId } = await objects.saveEvent(alice as never, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, { summary: "Kickoff", attendees: [{ email: GUEST }], ...fields }),
            floatingZone: ZONE
        });
        const invitation = db.rows("calendarInvitation").find((row) => row.objectId === objectId)!;
        return { objectId, token: String(invitation.token) };
    }

    it("shows the event the link is for", async () => {
        const { token } = await invite();
        const view = await rsvp.rsvpView(token);
        expect(view).toEqual(expect.objectContaining({ title: "Kickoff", organizer: "Alice", email: GUEST, partstat: "NEEDS-ACTION", recurring: false }));
        expect(await rsvp.rsvpView("x".repeat(32))).toBeNull();
    });

    it("records the answer on the organizer's copy and tells the organizer", async () => {
        const { objectId, token } = await invite();
        fake.notices.length = 0;
        await rsvp.answerByToken({ token, partstat: "ACCEPTED", recurrenceKey: null });
        const guest = world.eventIn(db.byId("calendarObject", objectId)).attendees.find((attendee) => attendee.email === GUEST);
        expect(guest?.partstat).toBe("ACCEPTED");
        expect(db.rows("calendarInvitation")[0]).toEqual(expect.objectContaining({ partstat: "ACCEPTED", respondedAt: expect.any(Date) }));
        expect(fake.notices).toEqual([expect.objectContaining({ userId: alice.id, event: "calendar.reply" })]);
        expect((await rsvp.rsvpView(token))?.partstat).toBe("ACCEPTED");
    });

    it("answers one occurrence of a series alone", async () => {
        const { objectId, token } = await invite({ rule: world.weekly({ kind: "count", count: 4 }) });
        const view = await rsvp.rsvpView(token);
        expect(view?.occurrences.length).toBe(4);
        const second = view!.occurrences[1]!.key;
        await rsvp.answerByToken({ token, partstat: "DECLINED", recurrenceKey: second });
        const item = world.itemIn(db.byId("calendarObject", objectId));
        if (item.component !== "VEVENT") throw new Error("not an event");
        expect(item.master?.attendees.find((attendee) => attendee.email === GUEST)?.partstat).toBe("NEEDS-ACTION");
        expect(item.overrides.flatMap((override) => override.attendees).find((attendee) => attendee.email === GUEST)?.partstat).toBe("DECLINED");
        await expect(rsvp.answerByToken({ token, partstat: "ACCEPTED", recurrenceKey: "2020-01-01T00:00:00.000Z" })).rejects.toThrow(
            world.en("rsvp.noSuchOccurrence")
        );
    });

    it("is rate limited per address and per link", async () => {
        const { token } = await invite();
        await rsvp.answerByToken({ token, partstat: "TENTATIVE", recurrenceKey: null });
        expect(fake.rateKeys).toEqual(["calendar.rsvp:203.0.113.7", `calendar.rsvp-token:${token}`]);
        fake.rateAllowed = false;
        await expect(rsvp.answerByToken({ token, partstat: "ACCEPTED", recurrenceKey: null })).rejects.toThrow(world.en("booking.slowDown"));
        expect(db.rows("calendarInvitation")[0]?.partstat).toBe("TENTATIVE");
    });

    it("refuses a link whose event was deleted", async () => {
        const { objectId, token } = await invite();
        await objects.deleteEvent(alice as never, { objectId, recurrenceKey: null, scope: "all", floatingZone: ZONE });
        await expect(rsvp.answerByToken({ token, partstat: "ACCEPTED", recurrenceKey: null })).rejects.toThrow(world.en("rsvp.linkGone"));
    });
});
