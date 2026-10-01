/**
 * Sharing and publishing: a manager shares but cannot hand out "manage", a new
 * share is announced once, turning publishing off kills the address for good,
 * and what a published link shows is decided by its mode - busy blocks only,
 * or public events in full with private ones still hidden.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import * as engine from "@polaris-app/calendar/src/engine";
import { addTeam, addUser, fake } from "../fixtures/fake-host";
import * as sharing from "@polaris-app/calendar/src/lib/sharing";
import * as published from "@polaris-app/calendar/src/lib/published";

const OCTOBER = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };

describe("calendar sharing", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let carol: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        carol = addUser({ name: "Carol", email: "carol@example.test" });
        calendar = world.addCalendar(alice.id, { name: "Team plans" });
    });

    it("lets a manager share, but not hand out manage or take a manager's share away", async () => {
        world.addShare(calendar, { userId: bob.id }, "manage");
        await sharing.share(bob, { calendarId: calendar, target: { kind: "user", id: carol.id }, access: "write" });
        expect(db.rows("calendarShare").find((row) => row.userId === carol.id)?.access).toBe("write");
        await expect(sharing.share(bob, { calendarId: calendar, target: { kind: "user", id: carol.id }, access: "manage" })).rejects.toThrow(
            world.en("sharing.onlyOwnerManage")
        );
        const dave = addUser({ name: "Dave", email: "dave@example.test" });
        const daveShare = world.addShare(calendar, { userId: dave.id }, "manage");
        await expect(sharing.unshare(bob, daveShare)).rejects.toThrow(world.en("sharing.onlyOwnerManage"));
        await expect(sharing.share(bob, { calendarId: calendar, target: { kind: "user", id: dave.id }, access: "freebusy" })).rejects.toThrow(
            world.en("sharing.onlyOwnerManage")
        );
        expect(db.byId("calendarShare", daveShare)?.access).toBe("manage");
        await sharing.share(alice, { calendarId: calendar, target: { kind: "user", id: carol.id }, access: "manage" });
        expect(db.rows("calendarShare").find((row) => row.userId === carol.id)?.access).toBe("manage");
    });

    it("refuses a writer or reader who tries to share", async () => {
        world.addShare(calendar, { userId: bob.id }, "write");
        await expect(sharing.share(bob, { calendarId: calendar, target: { kind: "user", id: carol.id }, access: "read" })).rejects.toThrow(
            world.en("errors.calendarNotFound")
        );
    });

    it("announces a share once, not again when its level changes", async () => {
        await sharing.share(alice, { calendarId: calendar, target: { kind: "user", id: bob.id }, access: "read" });
        await sharing.share(alice, { calendarId: calendar, target: { kind: "user", id: bob.id }, access: "read" });
        await sharing.share(alice, { calendarId: calendar, target: { kind: "user", id: bob.id }, access: "write" });
        expect(fake.notices).toEqual([expect.objectContaining({ userId: bob.id, event: "calendar.shared", href: `/calendar?c=${calendar}` })]);
        expect(fake.notices[0]?.title).toBe(world.en("sharing.sharedTitle", { who: "Alice", calendar: "Team plans" }));
        expect(db.rows("calendarShare")).toHaveLength(1);
    });

    it("shares with a team the sharer is on and tells its members, not the sharer", async () => {
        const team = addTeam("Design", [alice.id, bob.id, carol.id]);
        const outsiders = addTeam("Elsewhere", [bob.id]);
        await sharing.share(alice, { calendarId: calendar, target: { kind: "team", id: team }, access: "read" });
        expect(fake.notices.map((notice) => notice.userId).sort()).toEqual([bob.id, carol.id].sort());
        await expect(sharing.share(alice, { calendarId: calendar, target: { kind: "team", id: outsiders }, access: "read" })).rejects.toThrow(
            world.en("sharing.notYourTeam")
        );
        expect((await sharing.listShares(alice, calendar)).map((row) => row.target)).toEqual([{ kind: "team", id: team, name: "Design" }]);
    });

    it("refuses sharing with the owner", async () => {
        world.addShare(calendar, { userId: bob.id }, "manage");
        await expect(sharing.share(bob, { calendarId: calendar, target: { kind: "user", id: alice.id }, access: "read" })).rejects.toThrow(
            world.en("sharing.alreadyOwner")
        );
    });

    it("deletes the token when publishing stops, and mints a new one when it starts again", async () => {
        const first = await sharing.publish(alice, calendar, "busy");
        expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(await sharing.publish(alice, calendar, "full")).toBe(first);
        expect(await sharing.publish(alice, calendar, "")).toBeNull();
        expect(db.byId("calendar", calendar)).toMatchObject({ publicToken: null, publicMode: "" });
        expect(await sharing.publishedCalendar(first!)).toBeNull();
        const second = await sharing.publish(alice, calendar, "busy");
        expect(second).not.toBe(first);
        expect(await published.publishedFeed(first!, "Busy")).toBeNull();
        expect(await published.publishedFeed(second!, "Busy")).not.toBeNull();
    });

    it("rotates a published address and refuses to mail an unpublished one", async () => {
        await expect(sharing.mailPublicLink(alice, calendar, "friend@outside.test")).rejects.toThrow(world.en("sharing.notPublished"));
        const token = (await sharing.publish(alice, calendar, "full"))!;
        const rotated = await sharing.rotatePublicLink(alice, calendar);
        expect(rotated).not.toBe(token);
        expect(await sharing.publishedCalendar(token)).toBeNull();
        await sharing.mailPublicLink(alice, calendar, "friend@outside.test");
        expect(fake.mails[0]?.text).toContain(`https://polaris.example.test/cal/p/${rotated}`);
        expect(fake.rateKeys).toEqual([`calendar.mail-link:${alice.id}`]);
        fake.rateAllowed = false;
        await expect(sharing.mailPublicLink(alice, calendar, "friend@outside.test")).rejects.toThrow(world.en("sharing.slowDown"));
    });

    describe("what a published link shows", () => {
        beforeEach(() => {
            world.storeEvent(calendar, {
                uid: "public-1",
                summary: "Launch party",
                location: "Rooftop",
                description: "Bring snacks",
                alarms: [{ action: "DISPLAY", trigger: { kind: "relative", minutes: -30, related: "START" }, description: "" }],
                start: world.at("2026-10-10T18:00:00"),
                end: world.at("2026-10-10T21:00:00"),
                attendees: [{ email: bob.email, name: "Bob", role: "REQ-PARTICIPANT", partstat: "ACCEPTED", rsvp: false, type: "INDIVIDUAL" }]
            });
            world.storeEvent(calendar, {
                uid: "private-1",
                summary: "Therapy",
                location: "Clinic",
                classification: "PRIVATE",
                extraComponents: ["BEGIN:VLOCATION\r\nUID:loc-1\r\nNAME:Secret place\r\nEND:VLOCATION"],
                start: world.at("2026-10-11T09:00:00"),
                end: world.at("2026-10-11T10:00:00")
            });
            world.storeEvent(calendar, {
                uid: "free-1",
                summary: "Working from home",
                transparency: "TRANSPARENT",
                start: world.at("2026-10-12T09:00:00"),
                end: world.at("2026-10-12T17:00:00")
            });
        });

        it("hides every detail in busy mode, in the feed and on the page", async () => {
            const token = (await sharing.publish(alice, calendar, "busy"))!;
            const feed = (await published.publishedFeed(token, "Busy"))!;
            for (const secret of ["Launch party", "Rooftop", "Bring snacks", "Therapy", "Clinic", "Secret place", "bob@example.test", "Working from home"]) {
                expect(feed.ics).not.toContain(secret);
            }
            const parsed = engine.parseCalendarText(feed.ics);
            expect(parsed.items.map((item) => (item.component === "VEVENT" ? item.master?.summary : null))).toEqual(["Busy", "Busy"]);

            const range = (await published.publishedRange(token, OCTOBER, "UTC"))!;
            expect(range.occurrences).toHaveLength(2);
            expect(range.occurrences.every((occurrence) => occurrence.summary === "" && occurrence.location === "" && occurrence.busyOnly)).toBe(true);
            expect(JSON.stringify(range)).not.toContain("Launch party");
        });

        it("shows public events in full and private ones as busy blocks in full mode", async () => {
            const token = (await sharing.publish(alice, calendar, "full"))!;
            const feed = (await published.publishedFeed(token, "Busy"))!;
            expect(feed.ics).toContain("Launch party");
            // The owner's reminders never ring on a subscriber's phone.
            expect(feed.ics).not.toContain("BEGIN:VALARM");
            expect(feed.ics).not.toContain("Therapy");
            expect(feed.ics).not.toContain("Clinic");
            expect(feed.ics).not.toContain("Secret place");
            const range = (await published.publishedRange(token, OCTOBER, "UTC"))!;
            const party = range.occurrences.find((occurrence) => occurrence.summary === "Launch party");
            expect(party).toMatchObject({ location: "Rooftop", busyOnly: false });
            const therapy = range.occurrences.find((occurrence) => occurrence.start === "2026-10-11T07:00:00.000Z");
            expect(therapy).toMatchObject({ summary: "", location: "", busyOnly: true });
        });

        it("never gives the link guests, the organizer, attachments, unknown properties or private tasks", async () => {
            world.storeEvent(calendar, {
                uid: "meeting-1",
                summary: "Town hall",
                start: world.at("2026-10-14T10:00:00"),
                end: world.at("2026-10-14T11:00:00"),
                organizer: { email: alice.email, name: "Alice" },
                attendees: [{ email: "guest@outside.test", name: "Guest", role: "REQ-PARTICIPANT", partstat: "ACCEPTED", rsvp: false, type: "INDIVIDUAL" }],
                attachments: [{ uri: "https://files.example.test/budget.pdf", name: "budget.pdf", mime: "application/pdf" }],
                extra: [{ line: "X-INTERNAL-NOTE:salary review" }]
            });
            const task = engine.newTodo({ uid: "task-1", summary: "Call the lawyer", due: world.at("2026-10-15T12:00:00") });
            world.storeItem(calendar, engine.todoItem({ ...task, extra: [{ line: "CLASS:PRIVATE" }] }));
            world.storeItem(calendar, engine.todoItem(engine.newTodo({ uid: "task-2", summary: "Order cake", due: world.at("2026-10-16T12:00:00") })));
            const token = (await sharing.publish(alice, calendar, "full"))!;
            const feed = (await published.publishedFeed(token, "Busy"))!;
            expect(feed.ics).toContain("Town hall");
            expect(feed.ics).toContain("Order cake");
            for (const secret of ["guest@outside.test", "alice@example.test", "bob@example.test", "budget.pdf", "salary review", "Call the lawyer"]) {
                expect(feed.ics).not.toContain(secret);
            }
        });

        it("answers nothing for a trashed calendar or a malformed token", async () => {
            const token = (await sharing.publish(alice, calendar, "full"))!;
            db.byId("calendar", calendar)!.trashedAt = new Date();
            expect(await published.publishedRange(token, OCTOBER, "UTC")).toBeNull();
            expect(await sharing.publishedCalendar("short")).toBeNull();
        });
    });
});
