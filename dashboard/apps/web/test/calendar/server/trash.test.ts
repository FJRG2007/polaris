/**
 * The trash: what each person sees in it, restoring (an event written again,
 * to its provider too; a calendar with its reminders back), removing for good,
 * emptying, and the retention purge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const slot = vi.hoisted(() => ({ provider: null as unknown }));

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));
vi.mock("@polaris-app/calendar/src/lib/sync", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    createGoogleProvider: () => slot.provider
}));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser } from "../fixtures/fake-host";
import * as trash from "@polaris-app/calendar/src/lib/trash";
import { createFakeProvider } from "../fixtures/fake-provider";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import * as calendars from "@polaris-app/calendar/src/lib/calendars";
import { syncSource } from "@polaris-app/calendar/src/lib/sync-engine";

const ZONE = "Europe/Madrid";
const DAY = 86_400_000;

describe("calendar trash", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        calendar = world.addCalendar(alice.id, { name: "Work" });
    });

    async function create(calendarId: string, summary: string, alarms: unknown[] = []): Promise<string> {
        const saved = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendarId, { summary, alarms }),
            floatingZone: ZONE
        });
        return saved.objectId;
    }

    async function remove(objectId: string) {
        await objects.deleteEvent(alice, { objectId, recurrenceKey: null, scope: "all", floatingZone: ZONE });
    }

    it("lists trashed calendars to their owner and trashed events to whoever may write the calendar", async () => {
        const id = await create(calendar, "Old meeting");
        await remove(id);
        const other = world.addCalendar(alice.id, { name: "Archive" });
        await calendars.trashCalendar(alice, other);
        expect((await trash.listTrash(alice)).map((item) => [item.kind, item.title])).toEqual([
            ["calendar", "Archive"],
            ["event", "Old meeting"]
        ]);
        world.addShare(calendar, { userId: bob.id }, "read");
        expect(await trash.listTrash(bob)).toEqual([]);
        db.rows("calendarShare")[0]!.access = "write";
        expect((await trash.listTrash(bob)).map((item) => item.id)).toEqual([id]);
        const listed = (await trash.listTrash(alice)).find((item) => item.id === id)!;
        expect(new Date(listed.purgeAt).getTime() - new Date(listed.deletedAt).getTime()).toBe(30 * DAY);
    });

    it("restores an event by writing it again, and a provider calendar gets it back as new", async () => {
        const remote = createFakeProvider();
        slot.provider = remote.provider;
        remote.addCalendar({ remoteId: "primary", name: "Google" });
        const source = db.insert("calendarSource", { userId: alice.id, kind: "google", label: "Google", connectionId: "018f2b7a-0000-7000-8000-00000000c0de" }).id as string;
        await syncSource(source);
        const google = String(db.rows("calendar").find((row) => row.sourceId === source)!.id);

        const id = await create(google, "Synced");
        await world.settle();
        const href = String(db.byId("calendarObject", id)!.href);
        expect(remote.object("primary", href)).toBeDefined();
        await remove(id);
        await world.settle();
        expect(remote.object("primary", href)).toBeUndefined();
        expect(db.byId("calendarObject", id)).toMatchObject({ href: "", etag: "" });

        await trash.restoreTrash(alice, "event", id, ZONE);
        await world.settle();
        const restored = db.byId("calendarObject", id)!;
        expect(restored.deletedAt).toBeNull();
        expect(remote.writes.at(-1)).toMatchObject({ op: "put", href: null, ifMatch: null });
        expect(restored.href).not.toBe("");
        expect(remote.object("primary", String(restored.href))?.ics).toContain("Synced");
    });

    it("restores a calendar with its events' reminders planned again", async () => {
        const id = await create(calendar, "Standup", [{ action: "DISPLAY", trigger: { kind: "relative", minutes: -10, related: "START" } }]);
        expect(db.rows("calendarReminder").filter((row) => row.objectId === id)).toHaveLength(1);
        await calendars.trashCalendar(alice, calendar);
        expect(db.rows("calendarReminder")).toEqual([]);
        await trash.restoreTrash(alice, "calendar", calendar, ZONE);
        expect(db.byId("calendar", calendar)?.trashedAt).toBeNull();
        expect(db.rows("calendarReminder").filter((row) => row.objectId === id)).toHaveLength(1);
    });

    it("refuses to restore or purge what the person may not write", async () => {
        const id = await create(calendar, "Private");
        await remove(id);
        world.addShare(calendar, { userId: bob.id }, "read");
        await expect(trash.restoreTrash(bob, "event", id, ZONE)).rejects.toThrow(world.en("errors.eventNotFound"));
        await expect(trash.purgeTrash(bob, "event", id)).rejects.toThrow(world.en("errors.eventNotFound"));
        await calendars.trashCalendar(alice, calendar);
        await expect(trash.purgeTrash(bob, "calendar", calendar)).rejects.toThrow(world.en("errors.calendarNotFound"));
        expect(db.byId("calendar", calendar)).toBeDefined();
    });

    it("removes an event or a calendar for good, with everything in it", async () => {
        const id = await create(calendar, "Gone");
        await remove(id);
        await trash.purgeTrash(alice, "event", id);
        expect(db.byId("calendarObject", id)).toBeUndefined();

        const kept = await create(calendar, "Inside");
        world.addShare(calendar, { userId: bob.id }, "read");
        await calendars.trashCalendar(alice, calendar);
        await trash.purgeTrash(alice, "calendar", calendar);
        expect(db.byId("calendar", calendar)).toBeUndefined();
        expect(db.byId("calendarObject", kept)).toBeUndefined();
        expect(db.rows("calendarShare")).toEqual([]);
    });

    it("empties everything the person sees in the trash, and nothing else", async () => {
        const mine = await create(calendar, "Mine");
        await remove(mine);
        const live = await create(calendar, "Still here");
        const other = world.addCalendar(alice.id, { name: "Old" });
        await calendars.trashCalendar(alice, other);
        const bobs = world.addCalendar(bob.id, { name: "Bob's" });
        const bobsEvent = world.storeEvent(bobs, { summary: "Bob's deleted", start: world.at("2026-10-05T10:00:00"), end: world.at("2026-10-05T11:00:00") }, { deletedAt: new Date() });
        expect(await trash.emptyTrash(alice)).toBe(2);
        expect(db.byId("calendarObject", mine)).toBeUndefined();
        expect(db.byId("calendar", other)).toBeUndefined();
        expect(db.byId("calendarObject", live)).toBeDefined();
        expect(db.byId("calendarObject", String(bobsEvent.id))).toBeDefined();
    });

    it("purges what has been in the trash longer than the retention, every account's", async () => {
        const recent = await create(calendar, "Recent");
        await remove(recent);
        const old = world.storeEvent(calendar, { summary: "Old", start: world.at("2026-08-05T10:00:00"), end: world.at("2026-08-05T11:00:00") }, { deletedAt: new Date(world.NOW.getTime() - 31 * DAY) });
        const oldCalendar = world.addCalendar(bob.id, { trashedAt: new Date(world.NOW.getTime() - 40 * DAY) });
        expect(await trash.purgeExpiredTrash(world.NOW)).toBe(2);
        expect(db.byId("calendarObject", String(old.id))).toBeUndefined();
        expect(db.byId("calendar", oldCalendar)).toBeUndefined();
        expect(db.byId("calendarObject", recent)).toBeDefined();
    });
});
