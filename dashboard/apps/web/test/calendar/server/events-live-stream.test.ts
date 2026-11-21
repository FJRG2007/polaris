/**
 * An event created, moved or deleted through an assistant's calendar tool - or
 * answered from an invitation link - only showed on an open calendar at its next
 * load. Every event write now says which calendar moved, and the events stream
 * tells the tabs of the people who see that calendar - and nobody else's -
 * within a moment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, signIn } from "../fixtures/fake-host";
import * as rsvp from "@polaris-app/calendar/src/lib/rsvp";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import { onCalendarChanged, type CalendarChange } from "@polaris-app/calendar/src/lib/live";
import { GET as stream } from "@polaris-app/calendar/src/routes/api/calendar/events/stream/route";

const ZONE = "Europe/Madrid";
const GUEST = "guest@example.test";

/** Read frames off an open stream until `count` data frames arrived or the
 *  wait ran out. */
async function frames(response: Response, count: number, waitMs: number): Promise<string[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffer = "";
    const deadline = Date.now() + waitMs;
    while (seen.length < count && Date.now() < deadline) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))
        ]);
        if (!chunk || chunk.done) break;
        buffer += decoder.decode(chunk.value);
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) if (part.startsWith("data:")) seen.push(part);
    }
    return seen;
}

function open(signal: AbortSignal): Promise<Response> {
    return stream(new Request("http://x/api/calendar/events/stream", { signal }));
}

describe("an open calendar follows an event changed anywhere else", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let carol: ReturnType<typeof addUser>;
    let calendar: string;
    const heard: CalendarChange[] = [];
    let stop: () => void = () => {};
    const aborts: AbortController[] = [];

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        carol = addUser({ name: "Carol", email: "carol@example.test" });
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
        heard.length = 0;
        stop = onCalendarChanged((change) => heard.push(change));
    });

    afterEach(() => {
        stop();
        for (const abort of aborts.splice(0)) abort.abort();
    });

    function heldSignal(): AbortSignal {
        const abort = new AbortController();
        aborts.push(abort);
        return abort.signal;
    }

    async function create(fields: Record<string, unknown> = {}): Promise<string> {
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, fields),
            floatingZone: ZONE
        });
        return objectId;
    }

    it("announces a create, an edit, a delete and an answered invitation for the calendar", async () => {
        const objectId = await create({ attendees: [{ email: GUEST }] });
        const version = (db.byId("calendarObject", objectId)!.updatedAt as Date).toISOString();
        await objects.saveEvent(alice, {
            objectId,
            recurrenceKey: null,
            scope: "all",
            version,
            event: world.input(calendar, { summary: "Moved", attendees: [{ email: GUEST }] }),
            floatingZone: ZONE
        });
        const token = String(
            db.rows("calendarInvitation").find((row) => row.objectId === objectId)!.token
        );
        await rsvp.answerByToken({ token, partstat: "ACCEPTED", recurrenceKey: null });
        await objects.deleteEvent(alice, {
            objectId,
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        expect(heard.length).toBeGreaterThanOrEqual(4);
        for (const change of heard) expect(change).toEqual({ calendarId: calendar, ownerId: alice.id });
    });

    it("announces nothing for a write that is refused", async () => {
        await expect(
            objects.saveEvent(bob, {
                objectId: null,
                recurrenceKey: null,
                scope: "all",
                version: null,
                event: world.input(calendar),
                floatingZone: ZONE
            })
        ).rejects.toThrow();
        expect(heard).toHaveLength(0);
    });

    it("wakes the streams of the people who see the calendar within a second, and only theirs", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");

        signIn(alice);
        const own = await open(heldSignal());
        signIn(bob);
        const shared = await open(heldSignal());
        signIn(carol);
        const other = await open(heldSignal());
        expect(own.status).toBe(200);
        expect(own.headers.get("content-type")).toContain("text/event-stream");

        const started = Date.now();
        // A burst is one frame.
        await create();
        await create({ summary: "Second" });

        const [ownFrames, sharedFrames, otherFrames] = await Promise.all([
            frames(own, 2, 600),
            frames(shared, 2, 600),
            frames(other, 1, 600)
        ]);
        expect(ownFrames).toHaveLength(1);
        expect(sharedFrames).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(otherFrames).toHaveLength(0);
    });

    it("follows a calendar its owner created after the stream opened", async () => {
        signIn(alice);
        const own = await open(heldSignal());
        calendar = world.addCalendar(alice.id, { timezone: ZONE, name: "New" });
        await create();
        expect(await frames(own, 1, 600)).toHaveLength(1);
    });

    it("refuses a stream to nobody signed in", async () => {
        signIn(null);
        const response = await open(new AbortController().signal);
        expect(response.status).toBeGreaterThanOrEqual(400);
    });
});
