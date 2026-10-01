/**
 * Free/busy: somebody the reader may look up is answered with busy intervals
 * and nothing else - no title, no place, no attendee - leaving out what does
 * not block (a free event, a "never busy" calendar, a declined invitation);
 * anybody the reader may not look up, and any address with no account, is
 * answered `unavailable` the same way, with nothing in it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, host } from "../fixtures/fake-host";
import * as freebusy from "@polaris-app/calendar/src/lib/freebusy";

const ZONE = "Europe/Madrid";
const window = { from: new Date("2026-10-06T00:00:00+02:00"), to: new Date("2026-10-07T00:00:00+02:00") };

describe("free/busy", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let carol: ReturnType<typeof addUser>;
    const reachable = new Set<string>();

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        carol = addUser({ name: "Carol", email: "carol@example.test" });
        // The directory's rule, as the people picker answers it: Alice reaches
        // Bob and not Carol, whatever she types.
        reachable.clear();
        reachable.add(bob.id);
        host.calendarHost.peopleInReach = async (_actor: unknown, ids: readonly string[]) => ids.filter((id) => reachable.has(id));

        const work = world.addCalendar(bob.id, { timezone: ZONE });
        world.storeEvent(work, { summary: "Secret launch", location: "HQ", start: world.at("2026-10-06T10:00:00"), end: world.at("2026-10-06T11:00:00") });
        world.storeEvent(work, { summary: "Tentative", status: "TENTATIVE", start: world.at("2026-10-06T12:00:00"), end: world.at("2026-10-06T12:30:00") });
        world.storeEvent(work, { summary: "Free", transparency: "TRANSPARENT", start: world.at("2026-10-06T13:00:00"), end: world.at("2026-10-06T14:00:00") });
        world.storeEvent(work, {
            summary: "Declined",
            start: world.at("2026-10-06T15:00:00"),
            end: world.at("2026-10-06T16:00:00"),
            attendees: [{ email: bob.email, name: "", role: "REQ-PARTICIPANT", partstat: "DECLINED", rsvp: true, type: "INDIVIDUAL" }]
        });
        const never = world.addCalendar(bob.id, { transparent: true });
        world.storeEvent(never, { summary: "Hidden", start: world.at("2026-10-06T17:00:00"), end: world.at("2026-10-06T18:00:00") });
        const carols = world.addCalendar(carol.id);
        world.storeEvent(carols, { summary: "Carol's day", start: world.at("2026-10-06T09:00:00"), end: world.at("2026-10-06T10:00:00") });
    });

    it("answers busy intervals only, leaving out what does not block", async () => {
        const view = await freebusy.freeBusy(alice as never, { emails: [bob.email], userIds: [], ...window, zone: ZONE });
        const [answer] = view.people;
        expect(answer?.status).toBe("ok");
        expect(answer?.busy).toEqual([
            { start: "2026-10-06T08:00:00.000Z", end: "2026-10-06T09:00:00.000Z", type: "BUSY" },
            { start: "2026-10-06T10:00:00.000Z", end: "2026-10-06T10:30:00.000Z", type: "BUSY-TENTATIVE" }
        ]);
        const text = JSON.stringify(view);
        for (const secret of ["Secret launch", "HQ", "Tentative", "Declined", "Hidden"]) expect(text).not.toContain(secret);
        // Outside Bob's working hours (09:00-17:00 on a Tuesday by default).
        expect(answer?.away[0]).toEqual({ start: "2026-10-05T22:00:00.000Z", end: "2026-10-06T07:00:00.000Z" });
    });

    it("answers unavailable, with nothing in it, for people the reader may not look up and for unknown addresses", async () => {
        const view = await freebusy.freeBusy(alice as never, {
            emails: [carol.email, "nobody@outside.test"],
            userIds: [carol.id],
            ...window,
            zone: ZONE
        });
        expect(view.people).toEqual([
            { key: carol.email, name: "", status: "unavailable", busy: [], away: [] },
            { key: "nobody@outside.test", name: "", status: "unavailable", busy: [], away: [] },
            { key: carol.id, name: "", status: "unavailable", busy: [], away: [] }
        ]);
    });

    it("suggests times when everybody answered is free and at work", async () => {
        const view = await freebusy.freeBusy(alice as never, {
            emails: [bob.email],
            userIds: [alice.id],
            ...window,
            zone: ZONE,
            durationMinutes: 60,
            now: new Date("2026-10-06T06:00:00.000Z")
        });
        expect(view.suggestions[0]).toEqual({ start: "2026-10-06T07:00:00.000Z", end: "2026-10-06T08:00:00.000Z" });
        expect(view.suggestions.some((slot) => slot.start === "2026-10-06T08:00:00.000Z")).toBe(false);
    });

    it("says whether somebody is free right now for their card", async () => {
        const now = await freebusy.availabilityNow(alice as never, bob.id, ZONE, new Date("2026-10-06T08:15:00.000Z"));
        expect(now).toEqual({ status: "busy", until: "2026-10-06T09:00:00.000Z" });
        expect(await freebusy.availabilityNow(alice as never, carol.id, ZONE, new Date("2026-10-06T08:15:00.000Z"))).toEqual({
            status: "unavailable",
            until: null
        });
    });

    it("asks who the reader may look up by id, once for everybody, never by searching an address", async () => {
        const asked: string[][] = [];
        host.calendarHost.searchPeople = async () => {
            throw new Error("searched by address");
        };
        host.calendarHost.peopleInReach = async (_actor: unknown, ids: readonly string[]) => {
            asked.push([...ids]);
            return ids.filter((id) => reachable.has(id));
        };
        // Addresses that contain Bob's: a search for his would find them all.
        for (let index = 0; index < 8; index++) reachable.add(addUser({ name: `Bob ${index}`, email: `${index}bob@example.test` }).id);
        const view = await freebusy.freeBusy(alice as never, { emails: [bob.email, carol.email], userIds: [alice.id], ...window, zone: ZONE });
        expect(view.people.map((person) => person.status)).toEqual(["ok", "unavailable", "ok"]);
        expect(asked).toHaveLength(1);
        expect(asked[0]!.sort()).toEqual([bob.id, carol.id].sort());
    });

    it("reads every event reaching the window, however many there are, so no booking is dropped", async () => {
        const room = world.addCalendar(carol.id, { kind: "resource" });
        const filler = world.storeEvent(room, { uid: "filler-0", summary: "", start: world.at("2026-10-06T08:00:00"), end: world.at("2026-10-06T08:30:00") });
        const ics = String(filler.ics);
        for (let index = 1; index < 3001; index++) {
            db.insert("calendarObject", { ...filler, id: undefined, uid: `filler-${index}`, ics: ics.replace("UID:filler-0", `UID:filler-${index}`) });
        }
        world.storeEvent(room, { uid: "last", summary: "", start: world.at("2026-10-06T15:00:00"), end: world.at("2026-10-06T16:00:00") });
        const busy = await freebusy.calendarBusy([room], window, { floatingZone: ZONE });
        expect(busy.some((interval) => interval.start.toISOString() === "2026-10-06T13:00:00.000Z")).toBe(true);
    });
});
