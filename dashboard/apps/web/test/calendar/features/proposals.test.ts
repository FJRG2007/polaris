/**
 * Meeting proposals: everybody asked is reached (a Polaris account in the bell,
 * anybody else by mail) with a vote link of their own; a vote through the link
 * is recorded and the owner told; choosing a date writes the event with every
 * participant invited and closes the proposal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("./fixtures/scheduling-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { scheduling } from "./fixtures/scheduling-db";
import { addUser, fake } from "../fixtures/fake-host";
import * as proposals from "@polaris-app/calendar/src/lib/proposals";

const ZONE = "Europe/Madrid";
const GUEST = "guest@outside.test";

describe("meeting proposals", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        scheduling.reset();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
    });

    function create() {
        return proposals.createProposal(alice as never, {
            title: "Roadmap",
            description: "Next quarter",
            location: "Room 1",
            durationMinutes: 60,
            timezone: ZONE,
            notify: true,
            participants: [
                { email: bob.email, name: "Bob", required: true },
                { email: GUEST, name: "Guest", required: false }
            ],
            dates: ["2026-10-07T08:00:00.000Z", "2026-10-08T13:00:00.000Z"]
        });
    }

    function tokenOf(email: string): string {
        return String(scheduling.rows("calendarProposalParticipant").find((row) => row.email === email)!.token);
    }

    it("asks a Polaris account in the bell and anybody else by mail, each with their own link", async () => {
        const made = await create();
        expect(made.dates).toHaveLength(2);
        expect(made.participants.find((entry) => entry.email === bob.email)?.internal).toBe(true);
        expect(fake.notices).toEqual([
            expect.objectContaining({ userId: bob.id, event: "calendar.proposal", href: `/cal/vote/${tokenOf(bob.email)}` })
        ]);
        expect(fake.mails).toHaveLength(1);
        expect(fake.mails[0]!.to).toBe(GUEST);
        expect(fake.mails[0]!.text).toContain(`https://polaris.example.test/cal/vote/${tokenOf(GUEST)}`);
    });

    it("records a vote from the link and tells the owner; the link shows no one else's ballot", async () => {
        const made = await create();
        const [first, second] = made.dates;
        await proposals.castVotes(tokenOf(GUEST), { [first!.id]: "yes", [second!.id]: "no" });
        const view = await proposals.proposal(alice as never, made.id);
        expect(view.participants.find((entry) => entry.email === GUEST)?.votes).toEqual({ [first!.id]: "yes", [second!.id]: "no" });
        expect(fake.notices.at(-1)).toEqual(expect.objectContaining({ userId: alice.id, event: "calendar.proposal" }));
        const page = await proposals.votePage(tokenOf(bob.email));
        expect(page?.votes).toEqual({});
        expect(JSON.stringify(page)).not.toContain(GUEST);
    });

    it("writes the chosen date as an event with everybody invited, and closes the proposal", async () => {
        const made = await create();
        const chosen = made.dates[1]!;
        fake.mails.length = 0;
        const { objectId } = await proposals.chooseDate(alice as never, { proposalId: made.id, dateId: chosen.id, calendarId: calendar });
        const [row] = world.objectsIn(calendar);
        expect(row?.id).toBe(objectId);
        const event = world.eventIn(row);
        expect(event.summary).toBe("Roadmap");
        expect(event.attendees.map((attendee) => [attendee.email, attendee.role])).toEqual([
            [bob.email, "REQ-PARTICIPANT"],
            [GUEST, "OPT-PARTICIPANT"]
        ]);
        expect(new Date(String(row!.startsAt)).toISOString()).toBe(chosen.start);
        // The invitation path ran: the guest is mailed the event.
        expect(fake.mails.some((mail) => mail.to === GUEST && mail.calendar?.method === "REQUEST")).toBe(true);
        const closed = await proposals.proposal(alice as never, made.id);
        expect(closed.status).toBe("closed");
        expect(closed.objectId).toBe(objectId);
        await expect(proposals.castVotes(tokenOf(GUEST), {})).rejects.toThrow(world.en("proposals.closed"));
    });

    it("counts each email to somebody outside Polaris against the owner, and refuses before writing once that is spent", async () => {
        const made = await create();
        expect(fake.rateKeys).toEqual([`calendar.mail-out:${alice.id}`]);
        fake.rateAllowed = false;
        fake.mails.length = 0;
        await expect(create()).rejects.toThrow(world.en("proposals.slowDown"));
        const input = { ...made, notify: true, dates: made.dates.map((date) => date.start) };
        const participants = [...made.participants, { email: "new@outside.test", name: "New", required: true }];
        await expect(proposals.updateProposal(alice as never, made.id, { ...input, participants })).rejects.toThrow(world.en("proposals.slowDown"));
        expect(scheduling.rows("calendarProposal")).toHaveLength(1);
        expect(scheduling.rows("calendarProposalParticipant")).toHaveLength(2);
        expect(fake.mails).toEqual([]);
    });

    it("keeps someone else from opening or choosing on a proposal that is not theirs", async () => {
        const made = await create();
        await expect(proposals.proposal(bob as never, made.id)).rejects.toThrow(world.en("proposals.notFound"));
    });

    it("writes one event when the same date is chosen twice at once", async () => {
        const made = await create();
        const choice = { proposalId: made.id, dateId: made.dates[0]!.id, calendarId: calendar };
        const answers = await Promise.allSettled([proposals.chooseDate(alice as never, choice), proposals.chooseDate(alice as never, choice)]);
        expect(answers.map((answer) => answer.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(answers.find((answer) => answer.status === "rejected")).toMatchObject({ reason: { message: world.en("proposals.closed") } });
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("opens the proposal again when the chosen event could not be written", async () => {
        const made = await create();
        const objects = db.prisma.calendarObject as unknown as { create: (args: unknown) => Promise<unknown> };
        const original = objects.create;
        objects.create = async () => {
            throw new Error("database down");
        };
        try {
            await expect(proposals.chooseDate(alice as never, { proposalId: made.id, dateId: made.dates[0]!.id, calendarId: calendar })).rejects.toThrow("database down");
        } finally {
            objects.create = original;
        }
        const view = await proposals.proposal(alice as never, made.id);
        expect(view.status).toBe("open");
        expect(view.objectId).toBeNull();
    });
});
