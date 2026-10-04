/**
 * The two-way sync engine against an in-memory provider: pulls (first, since a
 * token, full, after an expired token), pushes with `If-Match` and the conflict
 * kept aside on a 412, resolving that conflict either way, an account whose
 * credentials were refused, retries of what did not push, and a local change on
 * its way that a pull must not undo.
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

import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import { FakePrismaError, db } from "../fixtures/fake-db";
import * as engine from "@polaris-app/calendar/src/engine";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import * as syncEngine from "@polaris-app/calendar/src/lib/sync-engine";
import { createFakeProvider, type FakeProvider } from "../fixtures/fake-provider";
import {
    SyncAuthError,
    SyncConsentError,
    SyncSetupError,
    SyncUnreachableError
} from "@polaris-app/calendar/src/lib/sync/errors";

const ZONE = "Europe/Madrid";

function icsFor(uid: string, summary: string, day = "2026-10-12"): string {
    return engine.serializeItem(
        engine.eventItem(
            world.event({
                uid,
                summary,
                start: world.at(`${day}T10:00:00`),
                end: world.at(`${day}T11:00:00`)
            })
        )
    );
}

describe("calendar sync engine", () => {
    let alice: ReturnType<typeof addUser>;
    let remote: FakeProvider;
    let sourceId: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        remote = createFakeProvider();
        slot.provider = remote.provider;
        remote.addCalendar({ remoteId: "primary", name: "Work", color: "#AA0000", timezone: ZONE });
        remote.remoteWrite("primary", "dentist", icsFor("dentist@google", "Dentist"));
        remote.remoteWrite("primary", "lunch", icsFor("lunch@google", "Lunch", "2026-10-13"));
        sourceId = db.insert("calendarSource", {
            userId: alice.id,
            kind: "google",
            label: "alice@gmail.example",
            connectionId: "018f2b7a-0000-7000-8000-00000000c0de"
        }).id as string;
    });

    const calendarRow = () => db.rows("calendar").find((row) => row.sourceId === sourceId)!;
    const objectAt = (href: string) => db.rows("calendarObject").find((row) => row.href === href);

    async function firstPull() {
        await syncEngine.syncSource(sourceId);
        return calendarRow();
    }

    async function edit(href: string, summary: string) {
        const row = objectAt(href)!;
        await objects.saveEvent(alice, {
            objectId: String(row.id),
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(String(row.calendarId), {
                summary,
                start: world.at("2026-10-12T10:00:00"),
                end: world.at("2026-10-12T11:00:00")
            }),
            floatingZone: ZONE
        });
        return String(row.id);
    }

    it("creates the provider's calendars and objects on the first pull", async () => {
        const calendar = await firstPull();
        expect(calendar).toMatchObject({
            kind: "remote",
            remoteId: "primary",
            name: "Work",
            color: "#aa0000",
            timezone: ZONE,
            ownerId: alice.id
        });
        expect(calendar.syncToken).not.toBe("");
        const dentist = objectAt("dentist")!;
        expect(dentist).toMatchObject({
            calendarId: calendar.id,
            uid: "dentist@google",
            summary: "Dentist",
            etag: remote.object("primary", "dentist")!.etag
        });
        expect(objectAt("lunch")?.summary).toBe("Lunch");
        expect(db.byId("calendarSource", sourceId)).toMatchObject({
            status: "ok",
            lastError: null
        });
        expect(db.byId("calendarSource", sourceId)?.lastSyncAt).toEqual(world.NOW);
        expect(fake.mails).toEqual([]);
    });

    it("pulls only what changed since the token: an edit updates, a deletion trashes", async () => {
        await firstPull();
        const etag = remote.remoteWrite(
            "primary",
            "dentist",
            icsFor("dentist@google", "Dentist (moved)", "2026-10-14")
        );
        remote.remoteDelete("primary", "lunch");
        await syncEngine.syncSource(sourceId);
        expect(remote.pulls.at(-1)?.syncToken).not.toBe("");
        expect(objectAt("dentist")).toMatchObject({
            summary: "Dentist (moved)",
            etag,
            deletedAt: null
        });
        expect(objectAt("dentist")?.startsAt).toEqual(new Date("2026-10-14T08:00:00Z"));
        expect(objectAt("lunch")?.deletedAt).toBeInstanceOf(Date);
    });

    it("trashes what a full pull no longer lists", async () => {
        const calendar = await firstPull();
        remote.forget("primary", "lunch");
        db.byId("calendar", String(calendar.id))!.syncToken = "";
        await syncEngine.syncSource(sourceId);
        expect(objectAt("lunch")?.deletedAt).toBeInstanceOf(Date);
        expect(objectAt("dentist")?.deletedAt).toBeNull();
    });

    it("starts again from nothing when the token expired (410)", async () => {
        const token = String((await firstPull()).syncToken);
        remote.expire(token);
        remote.forget("primary", "lunch");
        remote.remoteWrite("primary", "gym", icsFor("gym@google", "Gym", "2026-10-15"));
        await syncEngine.syncSource(sourceId);
        const [expiredPull, fullPull] = remote.pulls.slice(-2);
        expect(expiredPull?.syncToken).toBe(token);
        expect(fullPull?.syncToken).toBe("");
        expect(objectAt("gym")?.summary).toBe("Gym");
        expect(objectAt("lunch")?.deletedAt).toBeInstanceOf(Date);
        expect(db.byId("calendarSource", sourceId)?.status).toBe("ok");
    });

    it("marks a local edit to be pushed, then pushes it with If-Match and keeps the new etag", async () => {
        await firstPull();
        const before = objectAt("dentist")!.etag;
        const release = remote.holdPuts();
        const id = await edit("dentist", "Dentist, bring forms");
        expect(db.byId("calendarObject", id)?.pendingPush).toBe("put");
        release();
        await world.settle();
        expect(remote.writes).toEqual([
            { op: "put", remoteId: "primary", href: "dentist", ifMatch: before }
        ]);
        const stored = remote.object("primary", "dentist")!;
        expect(stored.ics).toContain("Dentist\\, bring forms");
        expect(db.byId("calendarObject", id)).toMatchObject({
            pendingPush: "",
            etag: stored.etag,
            conflictIcs: null
        });
    });

    it("sends again a row that changed while its push was on the way, with If-Match on the etag that push got", async () => {
        await firstPull();
        const before = objectAt("dentist")!.etag;
        const release = remote.holdPuts();
        const id = await edit("dentist", "First edit");
        db.byId("calendarObject", id)!.ics = icsFor("dentist@google", "Changed meanwhile");
        release();
        await world.settle();
        const stored = remote.object("primary", "dentist")!;
        expect(stored.ics).toContain("Changed meanwhile");
        expect(remote.writes.map((write) => write.ifMatch)).toEqual([before, expect.any(String)]);
        expect(remote.writes[1]?.ifMatch).not.toBe(before);
        expect(db.byId("calendarObject", id)).toMatchObject({
            pendingPush: "",
            etag: stored.etag,
            conflictIcs: null
        });
    });

    it("sends two quick edits one after the other, the provider ending with the last and nothing set aside", async () => {
        await firstPull();
        const release = remote.holdPuts();
        const id = await edit("dentist", "Edit one");
        await edit("dentist", "Edit two");
        release();
        await world.settle();
        const stored = remote.object("primary", "dentist")!;
        expect(stored.ics).toContain("Edit two");
        expect(db.byId("calendarObject", id)).toMatchObject({
            pendingPush: "",
            etag: stored.etag,
            conflictIcs: null
        });
        expect(world.eventIn(db.byId("calendarObject", id)).summary).toBe("Edit two");
    });

    it("creates at the provider an event made in Polaris", async () => {
        const calendar = await firstPull();
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(String(calendar.id), { summary: "New here" }),
            floatingZone: ZONE
        });
        await world.settle();
        const row = db.byId("calendarObject", objectId)!;
        expect(remote.writes.at(-1)).toMatchObject({ op: "put", href: null, ifMatch: null });
        expect(row.href).toBe(`${String(row.uid)}.ics`);
        expect(row.etag).toBe(remote.object("primary", String(row.href))?.etag);
        expect(row.pendingPush).toBe("");
    });

    it("keeps the provider's version on a 412 and sets the local one aside", async () => {
        await firstPull();
        remote.remoteWrite(
            "primary",
            "dentist",
            icsFor("dentist@google", "Dentist (their change)")
        );
        const id = await edit("dentist", "Dentist (my change)");
        await world.settle();
        const row = db.byId("calendarObject", id)!;
        expect(world.eventIn(row).summary).toBe("Dentist (their change)");
        expect(String(row.conflictIcs)).toContain("Dentist (my change)");
        expect(row.pendingPush).toBe("");
        expect(row.etag).toBe(remote.object("primary", "dentist")?.etag);
    });

    it("re-applies the local version when the person keeps theirs, and drops it when they keep the provider's", async () => {
        await firstPull();
        remote.remoteWrite("primary", "dentist", icsFor("dentist@google", "Theirs"));
        const id = await edit("dentist", "Mine");
        await world.settle();
        const theirEtag = remote.object("primary", "dentist")!.etag;
        await syncEngine.resolveConflict(id, "mine", ZONE);
        await world.settle();
        expect(remote.writes.at(-1)).toMatchObject({
            op: "put",
            href: "dentist",
            ifMatch: theirEtag
        });
        expect(remote.object("primary", "dentist")?.ics).toContain("SUMMARY:Mine");
        expect(db.byId("calendarObject", id)).toMatchObject({ conflictIcs: null, pendingPush: "" });

        remote.remoteWrite("primary", "dentist", icsFor("dentist@google", "Theirs again"));
        await edit("dentist", "Mine again");
        await world.settle();
        const writes = remote.writes.length;
        await syncEngine.resolveConflict(id, "theirs", ZONE);
        await world.settle();
        expect(remote.writes).toHaveLength(writes);
        expect(db.byId("calendarObject", id)?.conflictIcs).toBeNull();
        expect(world.eventIn(db.byId("calendarObject", id)).summary).toBe("Theirs again");
    });

    it("marks the account as needing authorization and tells its owner once", async () => {
        await firstPull();
        remote.failOn("list", new SyncAuthError("The server refused the credentials (401)", 401));
        await syncEngine.syncSource(sourceId);
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendarSource", sourceId)?.status).toBe("auth");
        expect(fake.notices).toEqual([
            expect.objectContaining({
                userId: alice.id,
                event: "calendar.syncFailed",
                href: "/calendar/settings/accounts"
            })
        ]);
        expect(fake.notices[0]?.body).toBe(world.en("sync.failedAuth"));
        expect((db.byId("calendarSource", sourceId)?.nextSyncAt as Date).getTime()).toBe(
            world.NOW.getTime() + 60 * 60_000
        );
    });

    const SETUP = {
        provider: "google" as const,
        service: "calendar-json.googleapis.com",
        project: "100000000001",
        activationUrl:
            "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=100000000001"
    };
    const minutes = (n: number) => world.NOW.getTime() + n * 60_000;
    const apiState = () =>
        JSON.parse(fake.settings.get("google-api.calendar") ?? "null") as Record<string, unknown>;

    it("waits on a switched-off API instead of asking to reconnect, and retries by itself", async () => {
        await firstPull();
        remote.failOn("list", new SyncSetupError("Google needs an API switched on", 403, SETUP));
        await syncEngine.syncSource(sourceId);
        const row = db.byId("calendarSource", sourceId)!;
        expect(row.status).toBe("setup");
        expect((row.nextSyncAt as Date).getTime()).toBe(minutes(2));
        expect(apiState()).toMatchObject({
            state: "disabled",
            project: "100000000001",
            activationUrl: SETUP.activationUrl,
            since: world.NOW.toISOString()
        });
        expect(fake.notices.map((notice) => notice.body)).toEqual([world.en("sync.failedSetup")]);

        // The longer it stays off, the less often it is asked - an hour at most.
        vi.setSystemTime(new Date(minutes(40)));
        await syncEngine.syncSource(sourceId, new Date(minutes(40)));
        expect((db.byId("calendarSource", sourceId)?.nextSyncAt as Date).getTime()).toBe(
            minutes(40 + 20)
        );
        vi.setSystemTime(new Date(minutes(600)));
        await syncEngine.syncSource(sourceId, new Date(minutes(600)));
        expect((db.byId("calendarSource", sourceId)?.nextSyncAt as Date).getTime()).toBe(
            minutes(600 + 60)
        );
        expect(fake.notices).toHaveLength(1);
    });

    it("clears the wait once Google answers, and makes every other waiting account due", async () => {
        await firstPull();
        const other = db.insert("calendarSource", {
            userId: alice.id,
            kind: "google",
            label: "second@gmail.example",
            connectionId: "018f2b7a-0000-7000-8000-00000000c0df",
            status: "setup",
            nextSyncAt: new Date(minutes(60))
        }).id as string;
        remote.failOn("list", new SyncSetupError("Google needs an API switched on", 403, SETUP));
        await syncEngine.syncSource(sourceId);
        remote.failOn("list", null);
        vi.setSystemTime(new Date(minutes(5)));
        await syncEngine.syncSource(sourceId, new Date(minutes(5)));
        expect(db.byId("calendarSource", sourceId)).toMatchObject({
            status: "ok",
            lastError: null
        });
        expect(apiState()).toMatchObject({ state: "enabled", project: null, activationUrl: null });
        expect((db.byId("calendarSource", other)?.nextSyncAt as Date).getTime()).toBe(minutes(5));
    });

    it("asks for calendar permission when the grant lacks it, and slows down when asked to", async () => {
        await firstPull();
        remote.failOn("list", new SyncConsentError("Google needs more permission", 403));
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendarSource", sourceId)?.status).toBe("consent");
        expect(fake.notices.map((notice) => notice.body)).toEqual([world.en("sync.failedConsent")]);

        remote.failOn("list", new SyncUnreachableError("Google asked to slow down", 429, 300));
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendarSource", sourceId)?.status).toBe("unreachable");
        expect((db.byId("calendarSource", sourceId)?.nextSyncAt as Date).getTime()).toBe(
            minutes(5)
        );
    });

    it("retries on the scheduled pass what the provider did not take", async () => {
        await firstPull();
        remote.failOn("put", new SyncUnreachableError("The server is unavailable (503)", 503));
        const id = await edit("dentist", "Offline change");
        await world.settle();
        expect(db.byId("calendarObject", id)?.pendingPush).toBe("put");
        remote.failOn("put", null);
        const result = await syncEngine.syncDueSources(world.NOW);
        expect(result).toEqual({ pulled: 0, pushed: 1 });
        expect(db.byId("calendarObject", id)?.pendingPush).toBe("");
        expect(remote.object("primary", "dentist")?.ics).toContain("Offline change");
    });

    it("does not trash a local change still on its way when a pull no longer lists it", async () => {
        await firstPull();
        remote.failOn("put", new SyncUnreachableError("The server is unavailable (503)", 503));
        const id = await edit("dentist", "Kept locally");
        await world.settle();
        remote.remoteDelete("primary", "dentist");
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendarObject", id)).toMatchObject({
            deletedAt: null,
            pendingPush: "put"
        });
    });

    it("does not bring back a local deletion still on its way when a pull lists the unchanged event", async () => {
        const calendar = await firstPull();
        remote.failOn("remove", new SyncUnreachableError("The server is unavailable (503)", 503));
        const id = String(objectAt("dentist")!.id);
        await objects.deleteEvent(alice, {
            objectId: id,
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        await world.settle();
        expect(db.byId("calendarObject", id)?.pendingPush).toBe("delete");
        db.byId("calendar", String(calendar.id))!.syncToken = "";
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendarObject", id)?.deletedAt).toBeInstanceOf(Date);
        expect(db.byId("calendarObject", id)?.pendingPush).toBe("delete");

        remote.failOn("remove", null);
        await syncEngine.syncDueSources(world.NOW);
        expect(remote.object("primary", "dentist")).toBeUndefined();
        expect(db.byId("calendarObject", id)).toMatchObject({ pendingPush: "", href: "" });
    });

    it("keeps every calendar when the provider's listing comes back empty", async () => {
        const calendar = await firstPull();
        (remote.provider as unknown as { listCalendars: () => Promise<unknown[]> }).listCalendars =
            async () => [];
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendar", String(calendar.id))).toBeDefined();
        expect(objectAt("dentist")?.deletedAt).toBeNull();
    });

    it("does not create a calendar twice when another pass created it first", async () => {
        const create = db.prisma.calendar.create;
        let raced = false;
        db.prisma.calendar.create = async (args: Parameters<typeof create>[0]) => {
            if (!raced) {
                raced = true;
                await create(args);
                throw new FakePrismaError(
                    "P2002",
                    "fake-db: unique calendar.sourceId_remoteId violated"
                );
            }
            return create(args);
        };
        try {
            await syncEngine.syncSource(sourceId);
        } finally {
            db.prisma.calendar.create = create;
        }
        expect(db.rows("calendar").filter((row) => row.sourceId === sourceId)).toHaveLength(1);
        expect(db.byId("calendarSource", sourceId)?.status).toBe("ok");
        expect(objectAt("dentist")?.summary).toBe("Dentist");
    });

    it("removes only what is missing inside the span a windowed full pull covers", async () => {
        await firstPull();
        const pull = remote.provider.pull.bind(remote.provider);
        (remote.provider as { pull: typeof pull }).pull = async (state) => ({
            ...(await pull({ ...state, syncToken: "" })),
            changed: [],
            full: true,
            window: {
                start: new Date("2026-10-13T00:00:00Z"),
                end: new Date("2027-10-13T00:00:00Z")
            }
        });
        await syncEngine.syncSource(sourceId);
        expect(objectAt("lunch")?.deletedAt).toBeInstanceOf(Date);
        expect(objectAt("dentist")?.deletedAt).toBeNull();
    });

    it("downloads a feed once a pass, conditionally, and keeps the name it was subscribed under", async () => {
        const feed = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Feed//EN",
            "X-WR-CALNAME:Their name",
            "X-WR-TIMEZONE:Europe/Madrid",
            "BEGIN:VEVENT",
            "UID:one@feed.test",
            "DTSTAMP:20260101T000000Z",
            "DTSTART:20261001T090000Z",
            "DTEND:20261001T100000Z",
            "SUMMARY:Standup",
            "END:VEVENT",
            "END:VCALENDAR",
            ""
        ].join("\r\n");
        const seen: Record<string, string>[] = [];
        fake.fetchHandler = async (_url, init) => {
            const headers = (init.headers ?? {}) as Record<string, string>;
            seen.push(headers);
            if (headers["If-None-Match"] === '"v1"') return new Response(null, { status: 304 });
            return new Response(feed, { status: 200, headers: { ETag: '"v1"' } });
        };
        const url = "https://feeds.example.test/team.ics";
        const feedSource = db.insert("calendarSource", {
            userId: alice.id,
            kind: "ics",
            label: "My name",
            url
        }).id as string;
        const calendarId = db.insert("calendar", {
            ownerId: alice.id,
            sourceId: feedSource,
            kind: "remote",
            remoteId: url,
            name: "My name",
            readOnly: true
        }).id as string;

        await syncEngine.syncSource(feedSource);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.["If-None-Match"]).toBeUndefined();
        expect(db.byId("calendar", calendarId)).toMatchObject({
            name: "My name",
            timezone: "Europe/Madrid",
            syncToken: '"v1"',
            remoteId: "feed"
        });
        expect(
            Buffer.from(
                db.byId("calendarSource", feedSource)?.encryptedSecret as Uint8Array
            ).toString("utf8")
        ).toBe(url);
        expect(db.byId("calendarSource", feedSource)?.url).toBe(
            "https://feeds.example.test/....ics"
        );
        expect(
            db.rows("calendarObject").filter((row) => row.calendarId === calendarId)
        ).toHaveLength(1);

        await syncEngine.syncSource(feedSource);
        expect(seen).toHaveLength(2);
        expect(seen[1]?.["If-None-Match"]).toBe('"v1"');
        expect(
            db
                .rows("calendar")
                .filter((row) => row.sourceId === feedSource)
                .map((row) => row.id)
        ).toEqual([calendarId]);
        expect(db.byId("calendar", calendarId)).toMatchObject({
            name: "My name",
            timezone: "Europe/Madrid"
        });
        expect(db.byId("calendarSource", feedSource)?.status).toBe("ok");
    });

    it("removes from Polaris the calendars deleted at the provider", async () => {
        const calendar = await firstPull();
        remote.addCalendar({ remoteId: "family", name: "Family" });
        await syncEngine.syncSource(sourceId);
        expect(db.rows("calendar").filter((row) => row.sourceId === sourceId)).toHaveLength(2);
        const family = db.rows("calendar").find((row) => row.remoteId === "family")!;
        remote.failOn("list", null);
        (remote.provider as unknown as { listCalendars: () => Promise<unknown[]> }).listCalendars =
            async () => [
                {
                    remoteId: "primary",
                    name: "Work",
                    color: null,
                    description: "",
                    timezone: null,
                    readOnly: false,
                    components: ["VEVENT"]
                }
            ];
        await syncEngine.syncSource(sourceId);
        expect(db.byId("calendar", String(family.id))).toBeUndefined();
        expect(db.byId("calendar", String(calendar.id))).toBeDefined();
    });

    describe("a Google account's tasks", () => {
        const TASKS_SETUP = {
            provider: "google" as const,
            service: "tasks.googleapis.com",
            project: "100000000001",
            activationUrl: null
        };
        const tasksState = () =>
            JSON.parse(fake.settings.get("google-api.tasks") ?? "null") as Record<
                string,
                unknown
            > | null;
        const todoIcs = engine.serializeItem(
            engine.todoItem(
                engine.newTodo({
                    uid: "t1@tasks.google.com",
                    summary: "Pay rent",
                    due: { date: "2026-10-12" }
                })
            )
        );
        const tasksCalendar = () =>
            db.rows("calendar").find((row) => row.remoteId === "tasks:list-1");

        beforeEach(() => {
            remote.addCalendar({
                remoteId: "tasks:list-1",
                name: "My Tasks",
                components: ["VTODO"]
            });
            remote.remoteWrite("tasks:list-1", "t1", todoIcs);
        });

        it("syncs a task list as a calendar of tasks, and says the Tasks API works", async () => {
            await firstPull();
            expect(tasksCalendar()).toMatchObject({ name: "My Tasks", components: "VTODO" });
            expect(objectAt("t1")).toMatchObject({
                uid: "t1@tasks.google.com",
                component: "VTODO"
            });
            expect(tasksState()).toMatchObject({ state: "enabled" });
        });

        it("keeps the calendars syncing, and the task list as it was, when the tasks were not granted", async () => {
            await firstPull();
            const pulled = () =>
                remote.pulls.filter((pull) => pull.remoteId === "tasks:list-1").length;
            const before = pulled();
            remote.dropCalendar("tasks:list-1");
            remote.setGaps([
                {
                    prefix: "tasks:",
                    cause: new SyncConsentError("Google needs more permission", 403)
                }
            ]);
            remote.remoteWrite("primary", "gym", icsFor("gym@google", "Gym", "2026-10-15"));
            await syncEngine.syncSource(sourceId);
            expect(db.byId("calendarSource", sourceId)?.status).toBe("ok");
            expect(objectAt("gym")).toBeDefined();
            expect(tasksCalendar()).toBeDefined();
            expect(objectAt("t1")?.deletedAt ?? null).toBeNull();
            expect(pulled()).toBe(before);
            expect(fake.notices).toEqual([]);
        });

        it("records the Tasks API as off, apart from the Calendar API, and the calendars still sync", async () => {
            await firstPull();
            remote.setGaps([
                {
                    prefix: "tasks:",
                    cause: new SyncSetupError("Google needs an API switched on", 403, TASKS_SETUP)
                }
            ]);
            await syncEngine.syncSource(sourceId);
            expect(db.byId("calendarSource", sourceId)?.status).toBe("ok");
            expect(tasksState()).toMatchObject({ state: "disabled", project: "100000000001" });
            expect(fake.settings.get("google-api.calendar")).toContain('"enabled"');

            remote.setGaps([]);
            await syncEngine.syncSource(sourceId);
            expect(tasksState()).toMatchObject({ state: "enabled" });
        });
    });
});
