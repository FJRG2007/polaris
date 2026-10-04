/**
 * A linked Google account's tasks, beside its calendars: each task list one
 * more calendar of tasks, due on a day (all Google keeps), done or not; what
 * changed pulled since the newest change seen; ticking one off, renaming or
 * deleting it written back; and an account that never granted the tasks, or a
 * project with the Tasks API off, still syncing its calendars.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";
import {
    SyncConsentError,
    SyncSetupError,
    SyncUnreachableError,
    createGoogleProvider,
    type CalendarProvider
} from "@polaris-app/calendar/src/lib/sync";
import {
    googleTaskToTodo,
    taskListOf,
    todoToGoogleTask
} from "@polaris-app/calendar/src/lib/sync/google-tasks";
import { createFakeGoogle } from "./fixtures/fake-google";
import { withGoogleTasks } from "./fixtures/fake-google-tasks";

function todoOf(ics: string): engine.CalendarTodo {
    const item = engine.parseCalendarText(ics).items[0]!;
    if (item.component !== "VTODO") throw new Error("not a task");
    return item.todo;
}

describe("a Google task as a task here", () => {
    it("is due on the day Google keeps, all day, and open", () => {
        const todo = googleTaskToTodo({
            id: "t1",
            title: "Pay rent",
            notes: "Transfer, not card",
            status: "needsAction",
            due: "2026-10-12T00:00:00.000Z"
        });
        expect(todo).toMatchObject({
            uid: "t1@tasks.google.com",
            summary: "Pay rent",
            description: "Transfer, not card",
            due: { date: "2026-10-12" },
            status: "NEEDS-ACTION",
            completed: null
        });
    });

    it("is done when Google says completed, stamped when it was", () => {
        const todo = googleTaskToTodo({
            id: "t2",
            status: "completed",
            completed: "2026-10-03T09:30:00.000Z"
        });
        expect(todo).toMatchObject({
            status: "COMPLETED",
            percent: 100,
            completed: "2026-10-03T09:30:00Z",
            due: null,
            summary: ""
        });
    });

    it("goes back as its day at midnight UTC, and opening it again clears the completion", () => {
        const base = engine.newTodo({ summary: "Call Ana", description: "About Friday" });
        expect(
            todoToGoogleTask({
                ...base,
                due: { dateTime: "2026-10-12T18:30:00", tzid: "Europe/Madrid" }
            })
        ).toEqual({
            title: "Call Ana",
            notes: "About Friday",
            status: "needsAction",
            due: "2026-10-12T00:00:00.000Z",
            completed: null
        });
        expect(
            todoToGoogleTask({ ...base, status: "COMPLETED", due: { date: "2026-10-12" } })
        ).toEqual({
            title: "Call Ana",
            notes: "About Friday",
            status: "completed",
            due: "2026-10-12T00:00:00.000Z"
        });
        expect(todoToGoogleTask(base).due).toBeNull();
    });

    it("names its list behind tasks:, which no calendar id starts with", () => {
        expect(taskListOf("tasks:MTIzNDU")).toBe("MTIzNDU");
        expect(taskListOf("primary@example.test")).toBeNull();
    });
});

describe("createGoogleProvider with Google Tasks", () => {
    let google: ReturnType<typeof createFakeGoogle>;
    let tasks: ReturnType<typeof withGoogleTasks>;
    let provider: CalendarProvider;

    beforeEach(() => {
        google = createFakeGoogle();
        tasks = withGoogleTasks(google.fetcher, { pageSize: 2 });
        tasks.addList("L1", "My Tasks");
        tasks.put("L1", {
            id: "a",
            title: "Pay rent",
            status: "needsAction",
            due: "2026-10-12T00:00:00.000Z"
        });
        tasks.put("L1", { id: "b", title: "Book flights", status: "needsAction" });
        tasks.put("L1", {
            id: "c",
            title: "Renew passport",
            status: "completed",
            completed: "2026-10-02T10:00:00.000Z",
            due: "2026-10-02T00:00:00.000Z",
            hidden: true
        });
        provider = createGoogleProvider({
            accessToken: google.accessToken,
            fetcher: tasks.fetcher
        });
    });

    it("lists each task list after the calendars, as a calendar of tasks", async () => {
        const calendars = await provider.listCalendars();
        expect(calendars.map((calendar) => calendar.remoteId)).toEqual([
            google.calendarId,
            "holidays@group.v.calendar.google.com",
            "busy@example.test",
            "tasks:L1"
        ]);
        expect(calendars.at(-1)).toMatchObject({
            name: "My Tasks",
            components: ["VTODO"],
            readOnly: false
        });
        expect(provider.listingGaps?.()).toEqual([]);
    });

    it("still lists the calendars of an account that never granted its tasks, and says why", async () => {
        tasks.answer("scope");
        const calendars = await provider.listCalendars();
        expect(calendars).toHaveLength(3);
        const [gap] = provider.listingGaps?.() ?? [];
        expect(gap?.prefix).toBe("tasks:");
        expect(gap?.cause).toBeInstanceOf(SyncConsentError);
    });

    it("tells a Tasks API switched off from a missing grant", async () => {
        tasks.answer("disabled");
        expect(await provider.listCalendars()).toHaveLength(3);
        const cause = provider.listingGaps?.()[0]?.cause;
        expect(cause).toBeInstanceOf(SyncSetupError);
        expect((cause as SyncSetupError).setup).toMatchObject({
            service: "tasks.googleapis.com",
            project: "100000000001"
        });
    });

    it("pulls a whole list the first time, over pages, finished ones included", async () => {
        const first = await provider.pull({
            remoteId: "tasks:L1",
            syncToken: "",
            ctag: "",
            known: new Map()
        });
        expect(first.full).toBe(true);
        expect(first.changed.map((object) => object.href)).toEqual(["a", "b", "c"]);
        const rent = todoOf(first.changed[0]!.ics);
        expect(rent).toMatchObject({ summary: "Pay rent", due: { date: "2026-10-12" } });
        expect(todoOf(first.changed[2]!.ics).status).toBe("COMPLETED");
        expect(first.syncToken).toBe(tasks.get("L1", "c")!.updated);
        const listing = tasks.requests.find((request) => request.url.pathname.endsWith("/tasks"))!;
        expect(listing.url.searchParams.get("showHidden")).toBe("true");
        expect(listing.url.searchParams.get("showCompleted")).toBe("true");
    });

    it("pulls only what changed since, deletions included", async () => {
        const first = await provider.pull({
            remoteId: "tasks:L1",
            syncToken: "",
            ctag: "",
            known: new Map()
        });
        const known = new Map(first.changed.map((object) => [object.href, object.etag]));
        tasks.put("L1", { id: "a", title: "Pay rent", status: "completed" });
        tasks.remove("L1", "b");
        const next = await provider.pull({
            remoteId: "tasks:L1",
            syncToken: first.syncToken,
            ctag: "",
            known
        });
        expect(next.full).toBe(false);
        expect(next.changed.map((object) => object.href)).toEqual(["a"]);
        expect(todoOf(next.changed[0]!.ics).status).toBe("COMPLETED");
        expect(next.removed).toEqual(["b"]);
        const asked = tasks.requests.at(-1)!.url.searchParams;
        expect(asked.get("updatedMin")).toBe(first.syncToken);
        expect(asked.get("showDeleted")).toBe("true");
    });

    it("writes a task ticked off here back to Google, and a new one as an insert", async () => {
        const first = await provider.pull({
            remoteId: "tasks:L1",
            syncToken: "",
            ctag: "",
            known: new Map()
        });
        const rent = first.changed[0]!;
        const done = engine.serializeItem(
            engine.todoItem({ ...todoOf(rent.ics), status: "COMPLETED", percent: 100 })
        );
        const written = await provider.put(
            { remoteId: "tasks:L1" },
            { href: "a", etag: rent.etag, ics: done, uid: "a@tasks.google.com" }
        );
        expect(written.href).toBe("a");
        expect(tasks.get("L1", "a")).toMatchObject({ status: "completed", title: "Pay rent" });
        expect(written.etag).toBe(tasks.get("L1", "a")!.etag);

        const fresh = engine.newTodo({ summary: "Water plants", due: { date: "2026-10-20" } });
        const created = await provider.put(
            { remoteId: "tasks:L1" },
            {
                href: null,
                etag: null,
                ics: engine.serializeItem(engine.todoItem(fresh)),
                uid: fresh.uid
            }
        );
        expect(tasks.get("L1", created.href)).toMatchObject({
            title: "Water plants",
            due: "2026-10-20T00:00:00.000Z",
            status: "needsAction"
        });
    });

    it("refuses to write an event into a task list", async () => {
        const event = engine.serializeItem(
            engine.eventItem(
                engine.newEvent({
                    uid: "e1",
                    start: { date: "2026-10-12" },
                    end: { date: "2026-10-13" }
                })
            )
        );
        await expect(
            provider.put(
                { remoteId: "tasks:L1" },
                { href: null, etag: null, ics: event, uid: "e1" }
            )
        ).rejects.toThrow("A task list only holds tasks");
    });

    it("deletes a task, and a task already gone is not an error", async () => {
        await provider.remove({ remoteId: "tasks:L1" }, { href: "b", etag: null });
        expect(tasks.get("L1", "b")?.deleted).toBe(true);
        await provider.remove({ remoteId: "tasks:L1" }, { href: "b", etag: null });
    });

    it("refuses an answer in an unexpected shape rather than reading it", async () => {
        tasks.answer("garbled");
        await expect(
            provider.pull({ remoteId: "tasks:L1", syncToken: "", ctag: "", known: new Map() })
        ).rejects.toBeInstanceOf(SyncUnreachableError);
    });

    it("leaves the calendars' own requests on the Calendar API", async () => {
        await provider.pull({
            remoteId: google.calendarId,
            syncToken: "",
            ctag: "",
            known: new Map()
        });
        expect(google.requests.every((request) => request.url.host === "www.googleapis.com")).toBe(
            true
        );
        expect(tasks.requests).toHaveLength(0);
    });
});
