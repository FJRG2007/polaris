/**
 * Calendar, as tools a connected assistant can call.
 *
 * Offered through the `mcpTools` hook, so they exist only while Calendar is
 * installed. Each reads and writes through the same modules the Calendar
 * screens do, as the person the call acts for: `access` decides which
 * calendars they reach and how far, `occurrences` reads a window the way the
 * grid does, and every change goes through `saveEvent` / `deleteEvent`, the
 * editor's own path - so a calendar shared read-only stays read-only, a busy
 * block stays a busy block, and invitations and providers hear about a change
 * exactly as they would from the screen.
 *
 * Reading takes `calendar.read`; creating, changing and deleting take
 * `calendar.manage`. `calendar_upcoming` also answers the `calendar.use`
 * scope it was offered under before the split, so a connection approved then
 * keeps working as it did.
 *
 * Server-only.
 */

import { z } from "zod";
import * as engine from "../engine";
import { host } from "@polaris/app-host";
import { attempt, readerFor, refuse } from "./mcp-common";
import { clockMcpSearch, clockMcpTools } from "./mcp-clock-tools";
import { listCalendars } from "./calendars";
import { eventDetail } from "./event-detail";
import { deleteEvent, saveEvent } from "./objects";
import { ruleTIn } from "./i18n";
import { isKnownZone } from "./schemas";
import type { AppHostTypes } from "@polaris/app-host";
import { readerView, upcomingEvents } from "./upcoming";
import { addressesOf, occurrencesIn } from "./occurrences";
import {
    alarmsFromMinutes,
    defaultAlarmMinutes,
    formFromDetail,
    inputOf,
    newForm,
    type EditorForm
} from "../screens/editor-model";

type McpTool = AppHostTypes["McpTool"];

/** The widest window one read answers. A model asking for a year at once is
 *  better told to ask for it a piece at a time than handed thousands of rows. */
const MAX_RANGE_DAYS = 62;
/** The most occurrences one read returns. */
const MAX_ROWS = 200;

const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Write a day as YYYY-MM-DD")
    .refine((text) => engine.dateValueSchema.safeParse({ date: text }).success, "No such day");

const when = z
    .string()
    .regex(
        /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/,
        "Write YYYY-MM-DD for an all-day event, or YYYY-MM-DDTHH:mm"
    );

const timeZone = z
    .string()
    .max(64)
    .refine(isKnownZone, "Not a time zone Polaris knows")
    .optional()
    .describe("An IANA time zone for the times given. Absent is the person's own.");

const objectId = z.string().uuid().describe("The event's id, as calendar_events returned it.");

const recurrenceKey = z
    .string()
    .min(8)
    .max(40)
    .optional()
    .describe(
        "For one occurrence of a repeating event: its recurrenceKey from calendar_events. Absent is the whole event."
    );

/** Four weeks, the furthest ahead of an event a reminder can be set. */
const REMINDER_MAX_MINUTES = 4 * 7 * 24 * 60;

const reminders = z
    .array(z.number().int().min(0).max(REMINDER_MAX_MINUTES))
    .max(5)
    .describe(
        "Minutes before the start to be reminded, e.g. [10, 60]; for an all-day event, before its midnight. [] for none."
    );

/** Reminders as a model gives them - minutes before - as the editor holds
 *  them: an offset from the start, negative for before. */
function remindersOf(minutes: readonly number[]) {
    return alarmsFromMinutes(minutes.map((value) => (value === 0 ? 0 : -value)));
}

const editScope = z
    .enum(["this", "following", "all"])
    .default("this")
    .describe(
        "With a recurrenceKey: just that occurrence, it and the ones after, or the whole series."
    );

/** Set the times of a form from what a model sent: a day for an all-day
 *  event (its end the last day it covers), a wall time in a zone otherwise. */
function withTimes(
    form: EditorForm,
    times: { start?: string; end?: string; zone: string }
): EditorForm {
    const start =
        times.start ?? (form.allDay ? form.startDate : `${form.startDate}T${form.startTime}`);
    const end = times.end ?? (form.allDay ? form.endDate : `${form.endDate}T${form.endTime}`);
    const allDay = !start.includes("T");
    if (allDay !== !end.includes("T"))
        refuse("Give the start and the end the same way: both days, or both times.");
    return {
        ...form,
        allDay,
        startDate: start.slice(0, 10),
        startTime: allDay ? form.startTime : start.slice(11, 16),
        startZone: allDay ? form.startZone : times.zone,
        endDate: end.slice(0, 10),
        endTime: allDay ? form.endTime : end.slice(11, 16),
        endZone: allDay ? form.endZone : times.zone
    };
}

/** What a form sends, through the schema the editor and the server check
 *  with. A problem is said in the person's language, as the screen says it. */
async function eventOf(form: EditorForm): Promise<engine.EventInput> {
    const parsed = engine.eventInputSchema.safeParse(inputOf(form));
    if (parsed.success) return parsed.data;
    const words = ruleTIn(await host.i18nRequest.getLocale());
    const key = `validation.${parsed.error.issues[0]?.message ?? ""}`;
    return refuse(words.has(key) ? words(key) : "Check the times and fields given.");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const upcomingInput = z.object({
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("How many events to return, soonest first.")
});

const upcomingTool = () =>
    host.mcp.defineTool({
        name: "calendar_upcoming",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Upcoming events",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "This account's next events over the coming two weeks, soonest first, from the calendars it shows. Read-only; calendar_events reads any range.",
        input: upcomingInput,
        category: "calendar",
        scope: ["calendar.read", "calendar.use"],
        readOnly: true,
        async run(input, caller) {
            const rows = (await upcomingEvents(caller.userId, input.limit)).map((event) => ({
                id: event.id,
                title: event.title,
                start: event.start,
                allDay: event.allDay
            }));
            if (rows.length === 0) {
                return { text: "Nothing in the next two weeks.", structured: { events: [] } };
            }
            return {
                text: rows
                    .map(
                        (row) =>
                            `${row.allDay ? row.start.slice(0, 10) : row.start}  ${row.title}${row.allDay ? " (all day)" : ""}`
                    )
                    .join("\n"),
                structured: { events: rows }
            };
        }
    });

const calendarsTool = () =>
    host.mcp.defineTool({
        name: "calendar_calendars",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "List calendars",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "The calendars this account reaches, with their ids and whether it may add events to them. Use an id with calendar_events or calendar_create.",
        input: z.object({}),
        category: "calendar",
        scope: "calendar.read",
        readOnly: true,
        async run(_input, caller) {
            const { user } = await readerFor(caller);
            const calendars = (await attempt(() => listCalendars(user))).map((calendar) => ({
                id: calendar.id,
                name: calendar.name,
                writable: calendar.writable,
                hidden: calendar.hidden,
                timeZone: calendar.timezone,
                owner: calendar.owner?.name ?? null
            }));
            return {
                text:
                    calendars
                        .map(
                            (calendar) =>
                                `${calendar.id}  ${calendar.name}${calendar.writable ? "" : " (read-only)"}${calendar.owner ? ` - ${calendar.owner}'s` : ""}`
                        )
                        .join("\n") || "No calendars.",
                structured: { calendars }
            };
        }
    });

const eventsInput = z.object({
    from: day.describe("The first day, YYYY-MM-DD, in the person's time zone."),
    to: day.describe(`The last day, inclusive. At most ${MAX_RANGE_DAYS} days after from.`),
    calendarId: z
        .string()
        .uuid()
        .optional()
        .describe("One calendar. Absent is every calendar the person shows.")
});

const eventsTool = () =>
    host.mcp.defineTool({
        name: "calendar_events",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Events in a range",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Every event between two days, as the person's calendar shows them, repeating ones expanded. Each comes with the objectId and recurrenceKey that calendar_update and calendar_delete take.",
        input: eventsInput,
        category: "calendar",
        scope: "calendar.read",
        readOnly: true,
        async run(input, caller) {
            const { user, zone, shown } = await readerFor(caller);
            const span = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000;
            if (span < 0) refuse("to is before from.");
            if (span >= MAX_RANGE_DAYS) refuse(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
            const window = {
                from: engine.valueToInstant({ date: input.from }, zone),
                to: engine.valueToInstant({ date: engine.addDays(input.to, 1) }, zone)
            };
            const view = await attempt(async () =>
                occurrencesIn(user, window, {
                    floatingZone: zone,
                    calendarIds: input.calendarId
                        ? [input.calendarId]
                        : shown.map((entry) => entry.id),
                    emails: await addressesOf(user),
                    includeTasks: false
                })
            );
            const events = view.occurrences.slice(0, MAX_ROWS).map((occurrence) => ({
                objectId: occurrence.objectId,
                recurrenceKey: occurrence.recurring ? occurrence.recurrenceKey : null,
                calendarId: occurrence.calendarId,
                title: occurrence.busyOnly ? "(busy)" : occurrence.summary,
                start: occurrence.allDay ? occurrence.startDate : occurrence.start,
                end: occurrence.allDay ? occurrence.endDate : occurrence.end,
                allDay: occurrence.allDay,
                location: occurrence.location,
                status: occurrence.status,
                editable: occurrence.editable
            }));
            const more = view.occurrences.length > MAX_ROWS || view.truncated;
            if (events.length === 0) {
                return { text: "Nothing in that range.", structured: { events, timeZone: zone } };
            }
            return {
                text:
                    events
                        .map(
                            (event) =>
                                `${event.start}${event.allDay ? " (all day)" : ` - ${event.end}`}  ${event.title}${event.location ? ` @ ${event.location}` : ""}  [${event.objectId}${event.recurrenceKey ? ` ${event.recurrenceKey}` : ""}]`
                        )
                        .join("\n") + (more ? "\n(More than this; ask for a shorter range.)" : ""),
                structured: { events, timeZone: zone, truncated: more }
            };
        }
    });

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

const createInput = z.object({
    calendarId: z
        .string()
        .uuid()
        .describe("The calendar to add it to, as calendar_calendars returned it."),
    title: z.string().trim().min(1).max(500).describe("What the event is called."),
    start: when.describe("YYYY-MM-DD for an all-day event, or YYYY-MM-DDTHH:mm."),
    end: when.describe(
        "The same form as start. For an all-day event, the last day it covers (inclusive)."
    ),
    timeZone,
    location: z.string().trim().max(1000).default("").describe("Where it is."),
    description: z.string().max(20_000).default("").describe("Notes on it."),
    reminders: reminders.optional().describe(
        "Minutes before the start to be reminded, e.g. [10, 60]. Absent uses the calendar's usual reminders; [] sets none."
    )
});

const createTool = () =>
    host.mcp.defineTool({
        name: "calendar_create",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Create an event",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Add an event to one of this account's writable calendars, with the reminders asked for or else the calendar's usual ones. It invites nobody.",
        input: createInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        destructive: false,
        async run(input, caller) {
            const { user, zone, preferences } = await readerFor(caller);
            const calendars = await attempt(() => listCalendars(user));
            const calendar = calendars.find((entry) => entry.id === input.calendarId);
            if (!calendar?.writable) refuse("This account cannot add events to that calendar.");
            const blank = newForm({
                calendarId: calendar.id,
                zone,
                allDay: true,
                start: input.start.slice(0, 10),
                end: engine.addDays(input.start.slice(0, 10), 1),
                summary: input.title,
                alarms: []
            });
            const timed = withTimes(blank, {
                start: input.start,
                end: input.end,
                zone: input.timeZone ?? zone
            });
            const form: EditorForm = {
                ...timed,
                location: input.location,
                description: input.description,
                alarms: input.reminders
                    ? remindersOf(input.reminders)
                    : alarmsFromMinutes(defaultAlarmMinutes(timed.allDay, calendar, preferences))
            };
            const event = await eventOf(form);
            const saved = await attempt(() =>
                saveEvent(user, {
                    objectId: null,
                    recurrenceKey: null,
                    scope: "all",
                    version: null,
                    event,
                    floatingZone: zone
                })
            );
            return {
                text: `Created "${input.title}" (${saved.objectId}).`,
                structured: { objectId: saved.objectId }
            };
        }
    });

const updateInput = z.object({
    objectId,
    recurrenceKey,
    scope: editScope,
    title: z.string().trim().min(1).max(500).optional().describe("A new title."),
    start: when.optional().describe("A new start, YYYY-MM-DD or YYYY-MM-DDTHH:mm."),
    end: when
        .optional()
        .describe("A new end, the same form as start. For all-day, the last day (inclusive)."),
    timeZone,
    location: z.string().trim().max(1000).optional().describe("A new location; empty clears it."),
    description: z.string().max(20_000).optional().describe("New notes; empty clears them."),
    reminders: reminders
        .optional()
        .describe("Replaces the event's reminders: minutes before the start; [] removes them all.")
});

const updateTool = () =>
    host.mcp.defineTool({
        name: "calendar_update",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Change an event",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Change the title, times, location, notes or reminders of an event this account may edit. Anything not given stays as it is; people invited are told of the change as they would be from the screen.",
        input: updateInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        idempotent: true,
        async run(input, caller) {
            const { user, zone } = await readerFor(caller);
            const detail = await attempt(async () =>
                eventDetail(user, {
                    objectId: input.objectId,
                    recurrenceKey: input.recurrenceKey ?? null,
                    floatingZone: zone,
                    emails: await addressesOf(user)
                })
            );
            if (!detail.writable) refuse("This account cannot change that event.");
            let form = formFromDetail(detail);
            if (input.start !== undefined || input.end !== undefined) {
                form = withTimes(form, {
                    start: input.start,
                    end: input.end,
                    zone: input.timeZone ?? (form.startZone || zone)
                });
            }
            form = {
                ...form,
                ...(input.title !== undefined ? { summary: input.title } : {}),
                ...(input.location !== undefined ? { location: input.location } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.reminders !== undefined ? { alarms: remindersOf(input.reminders) } : {})
            };
            const event = await eventOf(form);
            await attempt(() =>
                saveEvent(user, {
                    objectId: input.objectId,
                    recurrenceKey: input.recurrenceKey ?? null,
                    scope: input.recurrenceKey ? input.scope : "all",
                    version: detail.version,
                    event,
                    floatingZone: zone
                })
            );
            return { text: "Changed.", structured: { objectId: input.objectId } };
        }
    });

const deleteInput = z.object({ objectId, recurrenceKey, scope: editScope });

const deleteTool = () =>
    host.mcp.defineTool({
        name: "calendar_delete",
        // i18n-ignore shown by the calling client, which has no locale to ask for
        title: "Delete an event",
        description:
            // i18n-ignore read by the calling model, not shown to a person
            "Delete an event this account may edit - or one occurrence of a repeating one - into the Calendar's trash. People invited are told it is cancelled.",
        input: deleteInput,
        category: "calendar",
        scope: "calendar.manage",
        readOnly: false,
        destructive: true,
        async run(input, caller) {
            const { user, zone } = await readerFor(caller);
            await attempt(() =>
                deleteEvent(user, {
                    objectId: input.objectId,
                    recurrenceKey: input.recurrenceKey ?? null,
                    scope: input.recurrenceKey ? input.scope : "all",
                    floatingZone: zone
                })
            );
            return { text: "Deleted.", structured: { objectId: input.objectId } };
        }
    });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** How far back and ahead a search reads events, in days. */
const SEARCH_BEHIND_DAYS = 14;
const SEARCH_AHEAD_DAYS = 60;

/**
 * The calendars this account reaches and the events on the ones it shows,
 * from two weeks ago to two months ahead, for `polaris_search`. Read through
 * the same `occurrencesIn` the grid and `calendar_events` use, so a busy
 * block stays "(busy)" and a calendar not lent is not read.
 */
const searchProvider = () =>
    host.mcp.defineSearch({
        id: "calendar.events",
        app: "calendar",
        category: "calendar",
        scope: ["calendar.read", "calendar.use"],
        async search(_query, caller, limit) {
            const acting = await host.mcp.actingUser(caller.userId);
            const reader = acting ? await readerView(caller.userId) : null;
            if (!acting || !reader) return [];
            const now = Date.now();
            const [calendars, view] = await Promise.all([
                listCalendars(acting),
                occurrencesIn(
                    acting,
                    {
                        from: new Date(now - SEARCH_BEHIND_DAYS * 86_400_000),
                        to: new Date(now + SEARCH_AHEAD_DAYS * 86_400_000)
                    },
                    {
                        floatingZone: reader.zone,
                        calendarIds: reader.shown.map((entry) => entry.id),
                        emails: await addressesOf(acting),
                        includeTasks: false
                    }
                )
            ]);
            const names = new Map(calendars.map((calendar) => [calendar.id, calendar.name]));
            const hits: AppHostTypes["McpSearchHit"][] = calendars.map((calendar) => ({
                id: calendar.id,
                name: calendar.name,
                kind: "calendar",
                keywords: [calendar.owner?.name],
                next: calendar.writable
                    ? [{ tool: "calendar_create", args: { calendarId: calendar.id } }]
                    : []
            }));
            for (const occurrence of view.occurrences.slice(0, MAX_ROWS)) {
                if (occurrence.busyOnly) continue;
                const day = (occurrence.allDay ? occurrence.startDate : occurrence.start)?.slice(
                    0,
                    10
                );
                hits.push({
                    id: occurrence.recurring
                        ? `${occurrence.objectId}:${occurrence.recurrenceKey}`
                        : occurrence.objectId,
                    name: occurrence.summary,
                    kind: "calendar event",
                    where: [day, names.get(occurrence.calendarId)].filter(Boolean).join(", "),
                    keywords: [occurrence.location],
                    next: [
                        {
                            tool: "calendar_events",
                            args: { from: day, to: day, calendarId: occurrence.calendarId }
                        },
                        ...(occurrence.editable
                            ? [
                                  {
                                      tool: "calendar_update",
                                      args: {
                                          objectId: occurrence.objectId,
                                          ...(occurrence.recurring
                                              ? { recurrenceKey: occurrence.recurrenceKey }
                                              : {})
                                      }
                                  }
                              ]
                            : [])
                    ]
                });
            }
            return hits.slice(0, limit);
        }
    });

let searched: readonly AppHostTypes["McpSearchProvider"][] | undefined;

export function calendarMcpSearch(): readonly AppHostTypes["McpSearchProvider"][] {
    searched ??= [searchProvider(), ...clockMcpSearch()];
    return searched;
}

/** Built when the app is first asked for its tools, not when this module
 *  loads: `defineTool` is the host's, and a module of this app can be loaded
 *  before the dashboard has provided it (test/home/cold-start). */
let built: readonly McpTool[] | undefined;

export function calendarMcpTools(): readonly McpTool[] {
    built ??= [
        ...[upcomingTool, calendarsTool, eventsTool, createTool, updateTool, deleteTool].map(
            (tool) => tool()
        ),
        ...clockMcpTools()
    ];
    return built;
}
