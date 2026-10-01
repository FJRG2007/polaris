/**
 * Invitations from Polaris's own calendars: an outside guest is mailed an iMIP
 * REQUEST with an answer link, a Polaris account gets a copy in its own
 * calendar and a notice, a removed guest and a deleted event are CANCELled,
 * edits nobody would care about send nothing, an attendee's own copy sends
 * nothing, an attendee's answer reaches the organizer, and what an import or a
 * provider brings in is never sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import * as engine from "@polaris-app/calendar/src/engine";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import { importCalendar } from "@polaris-app/calendar/src/lib/transfer";
import { applyAnswer } from "@polaris-app/calendar/src/lib/invitations";

const ZONE = "Europe/Madrid";
const GUEST = "guest@outside.test";

describe("calendar invitations", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
    });

    async function save(
        attendees: string[],
        fields: Record<string, unknown> = {},
        objectId: string | null = null
    ): Promise<string> {
        const saved = await objects.saveEvent(alice, {
            objectId,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, {
                summary: "Kickoff",
                location: "Room 1",
                attendees: attendees.map((email) => ({ email })),
                ...fields
            }),
            floatingZone: ZONE
        });
        return saved.objectId;
    }

    function copyOf(userId: string, uid: unknown) {
        return db
            .rows("calendarObject")
            .find(
                (row) =>
                    row.uid === uid &&
                    db.byId("calendar", String(row.calendarId))?.ownerId === userId
            );
    }

    it("mails an outside guest an iMIP REQUEST with the link to answer", async () => {
        const id = await save([GUEST]);
        expect(fake.mails).toHaveLength(1);
        const mail = fake.mails[0]!;
        expect(mail.to).toBe(GUEST);
        expect(mail.calendar?.method).toBe("REQUEST");
        expect(mail.calendar?.ics).toMatch(/METHOD:REQUEST/);
        const invitation = db.rows("calendarInvitation").find((row) => row.objectId === id)!;
        expect(invitation.email).toBe(GUEST);
        expect(invitation.userId).toBeNull();
        expect(mail.text).toContain(
            `https://polaris.example.test/cal/rsvp/${String(invitation.token)}`
        );
        expect(mail.text).toContain("Kickoff");
        expect(mail.text).toContain("Room 1");
        expect(mail.text).toMatch(/Thursday, October 8, 2026 at 10:00\sAM GMT\+2/);
        expect(fake.notices).toEqual([]);
    });

    it("mails nobody outside once the organizer's hourly mail is spent, and still delivers inside", async () => {
        fake.rateAllowed = false;
        const id = await save([GUEST, bob.email]);
        expect(fake.mails).toEqual([]);
        expect(copyOf(bob.id, db.byId("calendarObject", id)!.uid)).toBeDefined();
    });

    it("puts the event in a Polaris attendee's own calendar with a notice, and mails nobody", async () => {
        const id = await save([bob.email]);
        expect(fake.mails).toEqual([]);
        const uid = db.byId("calendarObject", id)!.uid;
        const copy = copyOf(bob.id, uid);
        expect(copy).toBeDefined();
        expect(world.eventIn(copy).summary).toBe("Kickoff");
        expect(db.byId("calendar", String(copy!.calendarId))?.name).toBe(
            world.en("calendars.personal")
        );
        expect(fake.notices).toEqual([
            expect.objectContaining({
                userId: bob.id,
                event: "calendar.invitation",
                href: `/calendar/e/${String(copy!.id)}`
            })
        ]);
        expect(fake.notices[0]?.title).toBe(
            world.en("invitations.invitedTitle", { title: "Kickoff" })
        );
        expect(db.rows("calendarInvitation").find((row) => row.objectId === id)?.userId).toBe(
            bob.id
        );
    });

    it("cancels for a guest who was removed, and forgets their invitation", async () => {
        const id = await save([GUEST, "other@outside.test"]);
        fake.mails.length = 0;
        await save(["other@outside.test"], {}, id);
        expect(fake.mails).toHaveLength(1);
        expect(fake.mails[0]).toMatchObject({ to: GUEST, calendar: { method: "CANCEL" } });
        expect(fake.mails[0]?.subject).toBe(
            world.en("invitations.cancelledSubject", { title: "Kickoff" })
        );
        expect(db.rows("calendarInvitation").map((row) => row.email)).toEqual([
            "other@outside.test"
        ]);
    });

    it("sends nothing for an edit nobody invited would care about, and a new REQUEST when the time moves", async () => {
        const id = await save([GUEST]);
        fake.mails.length = 0;
        await save([GUEST], { description: "Agenda attached" }, id);
        expect(fake.mails).toEqual([]);
        await save(
            [GUEST],
            { start: world.at("2026-10-08T15:00:00"), end: world.at("2026-10-08T16:00:00") },
            id
        );
        expect(fake.mails).toHaveLength(1);
        expect(fake.mails[0]?.calendar?.method).toBe("REQUEST");
    });

    it("cancels for everybody when the event is deleted, marking the Polaris attendee's copy", async () => {
        const id = await save([GUEST, bob.email]);
        const uid = db.byId("calendarObject", id)!.uid;
        fake.mails.length = 0;
        fake.notices.length = 0;
        await objects.deleteEvent(alice, {
            objectId: id,
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        expect(fake.mails.map((mail) => [mail.to, mail.calendar?.method])).toEqual([
            [GUEST, "CANCEL"]
        ]);
        expect(world.eventIn(copyOf(bob.id, uid)).status).toBe("CANCELLED");
        expect(fake.notices).toEqual([
            expect.objectContaining({ userId: bob.id, event: "calendar.invitation" })
        ]);
    });

    it("does not bring back a copy the attendee already put in the trash when the event is cancelled", async () => {
        const id = await save([bob.email]);
        const uid = db.byId("calendarObject", id)!.uid;
        const copy = copyOf(bob.id, uid)!;
        await objects.deleteEvent(bob, {
            objectId: String(copy.id),
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        fake.notices.length = 0;
        await objects.deleteEvent(alice, {
            objectId: id,
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        expect(db.byId("calendarObject", String(copy.id))?.deletedAt).toBeInstanceOf(Date);
        expect(fake.notices).toEqual([]);
    });

    it("sends nothing when an attendee edits their own copy", async () => {
        const id = await save([bob.email, GUEST]);
        const copy = copyOf(bob.id, db.byId("calendarObject", id)!.uid)!;
        fake.mails.length = 0;
        fake.notices.length = 0;
        await objects.saveEvent(bob, {
            objectId: String(copy.id),
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(String(copy.calendarId), {
                summary: "Kickoff (mine)",
                start: world.at("2026-10-08T18:00:00"),
                end: world.at("2026-10-08T19:00:00"),
                attendees: [
                    { email: bob.email },
                    { email: GUEST },
                    { email: "friend@outside.test" }
                ]
            }),
            floatingZone: ZONE
        });
        expect(fake.mails).toEqual([]);
        expect(fake.notices).toEqual([]);
        expect(world.eventIn(db.byId("calendarObject", id)).summary).toBe("Kickoff");
    });

    it("carries a Polaris attendee's answer to the organizer's copy and tells the organizer", async () => {
        const id = await save([bob.email]);
        const copy = copyOf(bob.id, db.byId("calendarObject", id)!.uid)!;
        fake.notices.length = 0;
        await objects.respondToEvent(bob, {
            objectId: String(copy.id),
            recurrenceKey: null,
            partstat: "ACCEPTED",
            emails: [bob.email],
            floatingZone: ZONE
        });
        const organizerCopy = world.eventIn(db.byId("calendarObject", id));
        expect(
            organizerCopy.attendees.find((attendee) => attendee.email === bob.email)?.partstat
        ).toBe("ACCEPTED");
        expect(db.rows("calendarInvitation").find((row) => row.objectId === id)?.partstat).toBe(
            "ACCEPTED"
        );
        expect(fake.notices).toEqual([
            expect.objectContaining({
                userId: alice.id,
                event: "calendar.reply",
                href: `/calendar/e/${id}`
            })
        ]);
        expect(fake.mails).toEqual([]);
    });

    it("records an outside guest's answer from the link on the organizer's copy", async () => {
        const id = await save([GUEST]);
        const uid = String(db.byId("calendarObject", id)!.uid);
        fake.mails.length = 0;
        await applyAnswer(alice.id, uid, GUEST, "DECLINED", null);
        expect(world.eventIn(db.byId("calendarObject", id)).attendees[0]?.partstat).toBe(
            "DECLINED"
        );
        expect(db.rows("calendarInvitation")[0]?.partstat).toBe("DECLINED");
        expect(db.rows("calendarInvitation")[0]?.respondedAt).toBeInstanceOf(Date);
        expect(fake.notices[0]?.event).toBe("calendar.reply");
        expect(fake.mails).toEqual([]);
    });

    it("never sends for an imported event", async () => {
        const invite = engine.serializeItem(
            engine.eventItem(
                world.event({
                    uid: "imported-1",
                    summary: "From a file",
                    start: world.at("2026-10-12T10:00:00"),
                    end: world.at("2026-10-12T11:00:00"),
                    organizer: { email: alice.email, name: "Alice" },
                    attendees: [
                        {
                            email: GUEST,
                            name: "",
                            role: "REQ-PARTICIPANT",
                            partstat: "NEEDS-ACTION",
                            rsvp: true,
                            type: "INDIVIDUAL"
                        }
                    ]
                })
            ),
            { method: "REQUEST" }
        );
        const result = await importCalendar(alice, {
            target: { kind: "existing", calendarId: calendar },
            text: invite,
            floatingZone: ZONE
        });
        expect(result.imported).toBe(1);
        expect(fake.mails).toEqual([]);
        expect(db.rows("calendarInvitation")).toEqual([]);
    });

    it("never sends for what a provider calendar holds", async () => {
        const source = db.insert("calendarSource", {
            userId: alice.id,
            kind: "google",
            label: "Google"
        }).id as string;
        const remote = world.addCalendar(alice.id, {
            kind: "remote",
            sourceId: source,
            remoteId: "primary"
        });
        await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(remote, { attendees: [{ email: GUEST }] }),
            floatingZone: ZONE
        });
        await world.settle();
        expect(fake.mails).toEqual([]);
        expect(db.rows("calendarInvitation")).toEqual([]);
    });

    it("never overwrites an attendee's own event that shares the UID of an invitation", async () => {
        const own = world.storeEvent(world.addCalendar(bob.id), {
            uid: "bobs-own",
            summary: "Bob's dentist",
            start: world.at("2026-10-09T09:00:00"),
            end: world.at("2026-10-09T10:00:00"),
            organizer: { email: bob.email, name: "Bob" }
        });
        const forged = engine.serializeItem(
            engine.eventItem(
                world.event({
                    uid: "bobs-own",
                    summary: "Gone",
                    start: world.at("2026-10-12T10:00:00"),
                    end: world.at("2026-10-12T11:00:00"),
                    organizer: { email: alice.email, name: "Alice" },
                    attendees: [
                        {
                            email: bob.email,
                            name: "",
                            role: "REQ-PARTICIPANT",
                            partstat: "NEEDS-ACTION",
                            rsvp: true,
                            type: "INDIVIDUAL"
                        }
                    ]
                })
            )
        );
        await importCalendar(alice, {
            target: { kind: "existing", calendarId: calendar },
            text: forged,
            floatingZone: ZONE
        });
        const imported = db
            .rows("calendarObject")
            .find((row) => row.calendarId === calendar && row.uid === "bobs-own")!;
        await save(
            [bob.email],
            { start: world.at("2026-10-13T10:00:00"), end: world.at("2026-10-13T11:00:00") },
            String(imported.id)
        );
        expect(
            db
                .rows("calendarObject")
                .filter((row) => row.uid === "bobs-own" && row.calendarId !== calendar)
        ).toHaveLength(1);
        expect(world.eventIn(db.byId("calendarObject", String(own.id)))).toMatchObject({
            summary: "Bob's dentist",
            organizer: { email: bob.email }
        });
        expect(fake.notices).toEqual([]);
    });

    it("records an answer only from somebody invited, on an event the organizer organizes", async () => {
        const id = await save([GUEST]);
        const uid = String(db.byId("calendarObject", id)!.uid);
        const before = String(db.byId("calendarObject", id)!.ics);
        await applyAnswer(alice.id, uid, "stranger@outside.test", "ACCEPTED", null);
        expect(db.byId("calendarObject", id)!.ics).toBe(before);
        expect(fake.notices).toEqual([]);

        const theirs = world.storeEvent(world.addCalendar(bob.id), {
            uid: "alices-invite",
            summary: "Alice's party",
            start: world.at("2026-10-09T19:00:00"),
            end: world.at("2026-10-09T22:00:00"),
            organizer: { email: alice.email, name: "Alice" },
            attendees: [
                {
                    email: GUEST,
                    name: "",
                    role: "REQ-PARTICIPANT",
                    partstat: "NEEDS-ACTION",
                    rsvp: true,
                    type: "INDIVIDUAL"
                }
            ]
        });
        await applyAnswer(bob.id, "alices-invite", GUEST, "DECLINED", null);
        expect(
            world.eventIn(db.byId("calendarObject", String(theirs.id))).attendees[0]?.partstat
        ).toBe("NEEDS-ACTION");
        expect(fake.notices).toEqual([]);
    });
});
