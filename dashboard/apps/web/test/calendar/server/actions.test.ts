/**
 * The Calendar's server actions as a screen calls them: input that does not
 * validate is answered `{ ok: false }` with a sentence in the reader's words and
 * never thrown; a refusal reaches the screen as written; anything else is logged
 * and answered with a generic sentence; a sign-in redirect is let through.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import * as engine from "@polaris-app/calendar/src/engine";
import { addUser, fake, signIn } from "../fixtures/fake-host";
import * as tasks from "@polaris-app/calendar/src/actions/tasks";
import * as trash from "@polaris-app/calendar/src/actions/trash";
import * as events from "@polaris-app/calendar/src/actions/events";
import * as sharing from "@polaris-app/calendar/src/actions/sharing";
import * as sources from "@polaris-app/calendar/src/actions/sources";
import * as transfer from "@polaris-app/calendar/src/actions/transfer";
import * as calendars from "@polaris-app/calendar/src/actions/calendars";
import * as preferences from "@polaris-app/calendar/src/actions/preferences";

const ZONE = "Europe/Madrid";
const MISSING = "018f2b7a-0000-7000-8000-00000000dead";

describe("calendar actions", () => {
    let alice: ReturnType<typeof addUser>;
    let calendar: string;
    let logged: MockInstance<typeof console.error>;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        signIn(alice);
        calendar = world.addCalendar(alice.id, { name: "Work" });
        logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        logged.mockRestore();
    });

    const checkInput = () => ({ ok: false, error: world.en("errors.checkInput") });

    it("answers invalid input with a sentence instead of throwing, for every action", async () => {
        const answers = await Promise.all([
            calendars.createCalendarAction({
                name: "   ",
                color: "red",
                description: "",
                timezone: "",
                components: "VEVENT"
            }),
            calendars.updateCalendarAction("not-a-uuid", {}),
            calendars.updateCalendarAction(calendar, { owner: "me" }),
            calendars.setDisplayAction(calendar, { hidden: "yes" }),
            calendars.reorderCalendarsAction(["x"]),
            calendars.trashCalendarAction(42),
            calendars.leaveCalendarAction(null),
            events.openEventAction({
                objectId: MISSING,
                recurrenceKey: null,
                zone: "Mars/Olympus"
            }),
            events.openTodoAction("nope"),
            events.saveEventAction(undefined),
            events.shiftEventAction({
                objectId: MISSING,
                recurrenceKey: null,
                startDeltaMs: 1.5,
                endDeltaMs: 0,
                scope: "all",
                version: null,
                zone: ZONE
            }),
            events.deleteEventAction({
                objectId: MISSING,
                recurrenceKey: null,
                scope: "some",
                zone: ZONE
            }),
            events.duplicateEventAction({ objectId: MISSING }),
            events.respondToEventAction({
                objectId: MISSING,
                recurrenceKey: null,
                partstat: "NEEDS-ACTION",
                zone: ZONE
            }),
            preferences.savePreferencesAction({ view: "decade" }),
            preferences.savePreferencesAction({ unknown: true }),
            sharing.listSharesAction(""),
            sharing.shareCalendarAction({
                calendarId: calendar,
                target: { kind: "org", id: MISSING },
                access: "read"
            }),
            sharing.unshareCalendarAction(undefined),
            sharing.shareTargetsAction("x".repeat(101)),
            sharing.publishCalendarAction({ calendarId: calendar, mode: "everything" }),
            sharing.rotatePublicLinkAction(1),
            sharing.mailPublicLinkAction({ calendarId: calendar, email: "not an address" }),
            sources.addFeedAction({
                url: "https://asdf",
                name: "Feed",
                color: "#2ca02c",
                refreshMinutes: 60
            }),
            sources.addCalDavAction({
                url: "https://cloud.example.test",
                username: "",
                password: "x"
            }),
            sources.addLinkedAccountAction("x"),
            sources.refreshSourceAction(""),
            sources.updateSourceAction({ id: MISSING, refreshMinutes: 1 }),
            sources.removeSourceAction(""),
            sources.resolveConflictAction({ objectId: MISSING, keep: "both", zone: ZONE }),
            tasks.scheduleTaskAction({ taskId: MISSING, due: { at: "tomorrow", timed: true } }),
            tasks.saveTodoAction({
                objectId: MISSING,
                version: "x",
                summary: "",
                due: null,
                status: "DONE",
                zone: ZONE
            }),
            transfer.importCalendarAction({
                target: { kind: "existing", calendarId: "x" },
                text: ""
            }),
            trash.restoreTrashAction({ kind: "task", id: MISSING }),
            trash.purgeTrashAction({ kind: "event", id: "x" })
        ]);
        for (const answer of answers) {
            expect(answer.ok).toBe(false);
            expect(typeof (answer as { error: string }).error).toBe("string");
            expect((answer as { error: string }).error.length).toBeGreaterThan(0);
            expect((answer as { error: string }).error).not.toMatch(/^(validation|errors)\./);
        }
        expect(answers[0]).toEqual(checkInput());
        expect(db.rows("calendar")).toHaveLength(1);
        expect(logged).not.toHaveBeenCalled();
    });

    it("says what is wrong with an event in the reader's words", async () => {
        const answer = await events.saveEventAction({
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            zone: ZONE,
            event: {
                calendarId: calendar,
                summary: "Backwards",
                start: world.at("2026-10-08T11:00:00"),
                end: world.at("2026-10-08T10:00:00"),
                allDay: false
            }
        });
        expect(answer).toEqual({ ok: false, error: world.enRule("validation.endBeforeStart") });
        fake.requestLocale = "es-ES";
        const spanish = await events.saveEventAction({
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            zone: ZONE,
            event: {
                calendarId: calendar,
                summary: "Backwards",
                start: world.at("2026-10-08T11:00:00"),
                end: world.at("2026-10-08T10:00:00"),
                allDay: false
            }
        });
        expect(spanish.ok).toBe(false);
        expect((spanish as { error: string }).error).not.toBe(
            world.enRule("validation.endBeforeStart")
        );
    });

    it("passes a refusal through as written", async () => {
        expect(
            await events.openEventAction({ objectId: MISSING, recurrenceKey: null, zone: ZONE })
        ).toEqual({ ok: false, error: world.en("errors.eventNotFound") });
        expect(await calendars.trashCalendarAction(MISSING)).toEqual({
            ok: false,
            error: world.en("errors.calendarNotFound")
        });
        expect(logged).not.toHaveBeenCalled();
    });

    it("logs anything else and answers with the generic sentence", async () => {
        const failing = vi
            .spyOn(db.prisma.calendar, "create")
            .mockRejectedValueOnce(new Error("connection reset by 10.0.0.3:5432"));
        const answer = await calendars.createCalendarAction({
            name: "Side project",
            color: "#2ca02c",
            description: "",
            timezone: "",
            components: "VEVENT"
        });
        expect(answer).toEqual({ ok: false, error: world.en("errors.generic") });
        expect(JSON.stringify(answer)).not.toContain("10.0.0.3");
        expect(logged).toHaveBeenCalledWith(
            "polaris: a calendar action failed:",
            expect.any(Error)
        );
        failing.mockRestore();
    });

    it("lets the session's redirect through for somebody not signed in", async () => {
        signIn(null);
        await expect(calendars.listCalendarsAction()).rejects.toThrow(/NEXT_REDIRECT/);
    });

    it("creates a calendar, answers its summary, and keeps settings", async () => {
        const created = await calendars.createCalendarAction({
            name: "  Side   project ",
            color: "#2CA02C",
            description: "",
            timezone: "Europe/Madrid",
            components: "VEVENT"
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.calendar).toMatchObject({
            name: "Side project",
            color: "#2ca02c",
            reach: "owner",
            writable: true
        });

        const saved = await preferences.savePreferencesAction({
            view: "month",
            showWeekends: false
        });
        expect(saved.ok && saved.preferences.view).toBe("month");
        const row = db.rows("calendarPreference")[0]!;
        const stamp = (row.updatedAt as Date).getTime();
        await preferences.savePreferencesAction({ view: "month" });
        expect((db.rows("calendarPreference")[0]!.updatedAt as Date).getTime()).toBe(stamp);
        const loaded = await preferences.loadPreferencesAction();
        expect(loaded.ok && loaded.preferences.showWeekends).toBe(false);
    });

    it("refuses saving a task in a zone nobody knows", async () => {
        const todo = world.storeItem(
            calendar,
            engine.todoItem(engine.newTodo({ uid: "todo-1", summary: "Taxes" }))
        );
        const answer = await tasks.saveTodoAction({
            objectId: todo.id,
            version: (todo.updatedAt as Date).toISOString(),
            summary: "File taxes",
            due: { date: "2026-10-20" },
            status: "COMPLETED",
            zone: "Mars/Olympus"
        });
        expect(answer).toEqual(checkInput());
        const item = world.itemIn(db.byId("calendarObject", String(todo.id)));
        expect(item.component === "VTODO" && item.todo.summary).toBe("Taxes");
    });

    it("saves a calendar task and schedules a Tasks-app task", async () => {
        const todo = world.storeItem(
            calendar,
            engine.todoItem(engine.newTodo({ uid: "todo-1", summary: "Taxes" }))
        );
        const answer = await tasks.saveTodoAction({
            objectId: todo.id,
            version: (todo.updatedAt as Date).toISOString(),
            summary: "File taxes",
            due: { date: "2026-10-20" },
            status: "COMPLETED",
            zone: ZONE
        });
        expect(answer).toEqual({ ok: true });
        const item = world.itemIn(db.byId("calendarObject", String(todo.id)));
        if (item.component !== "VTODO") throw new Error("a task expected");
        expect(item.todo).toMatchObject({
            summary: "File taxes",
            status: "COMPLETED",
            percent: 100,
            due: { date: "2026-10-20" }
        });
        expect(item.todo.completed).not.toBeNull();

        expect(
            await tasks.scheduleTaskAction({
                taskId: MISSING,
                due: { at: "2026-10-20T09:00:00+02:00", timed: true }
            })
        ).toEqual({ ok: true });
        expect(fake.scheduled).toEqual([
            { taskId: MISSING, due: { at: "2026-10-20T09:00:00+02:00", timed: true } }
        ]);
    });
});
