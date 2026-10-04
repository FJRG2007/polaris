/**
 * Google Calendar, through the Calendar API v3.
 *
 * Google speaks JSON, not iCalendar, and splits a recurring series the other
 * way round: the master is one event and each changed occurrence is another,
 * linked by `recurringEventId`. The sync engine stores one object per UID, so a
 * pull gathers a series back into one object - master plus overrides, with a
 * cancelled occurrence becoming an EXDATE - and a write splits it again.
 *
 * Incremental pulls use Google's `syncToken`; a 410 means the token expired and
 * the caller starts over. Writes carry the master's etag in `If-Match`, so an
 * edit made on the phone in the meantime is a conflict, not an overwrite.
 */

import { z } from "zod";
import * as bridge from "./bridge";
import type * as types from "../../engine/types";
import { GOOGLE_APIS, readGoogleApiError } from "@polaris/core";
import * as tasks from "./google-tasks";
import { errorForProblem, readJson, send, type Fetcher } from "./http";
import type {
    CalendarProvider,
    ChangeSet,
    ListingGap,
    PullState,
    RemoteCalendar,
    RemoteObject,
    WriteTarget
} from "./provider";
import {
    SyncAuthError,
    SyncConsentError,
    SyncError,
    SyncRefusedError,
    SyncSetupError,
    SyncUnreachableError
} from "./errors";

export const GOOGLE_API = "https://www.googleapis.com/calendar/v3";

/** The Cloud API this client calls, as Google names it. */
const CALENDAR_API = GOOGLE_APIS.find((api) => api.id === "calendar")!;

const EventDateTime = z.object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
    timeZone: z.string().optional()
});

const GooglePerson = z.object({
    email: z.string().optional(),
    displayName: z.string().optional(),
    self: z.boolean().optional()
});

const GoogleAttendee = GooglePerson.extend({
    responseStatus: z.string().optional(),
    optional: z.boolean().optional(),
    resource: z.boolean().optional(),
    organizer: z.boolean().optional()
});

const GoogleEvent = z.object({
    id: z.string(),
    etag: z.string().optional(),
    status: z.string().optional(),
    iCalUID: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: EventDateTime.optional(),
    end: EventDateTime.optional(),
    endTimeUnspecified: z.boolean().optional(),
    originalStartTime: EventDateTime.optional(),
    recurringEventId: z.string().optional(),
    recurrence: z.array(z.string()).optional(),
    attendees: z.array(GoogleAttendee).optional(),
    organizer: GooglePerson.optional(),
    reminders: z
        .object({
            useDefault: z.boolean().optional(),
            overrides: z.array(z.object({ method: z.string(), minutes: z.number() })).optional()
        })
        .optional(),
    transparency: z.string().optional(),
    visibility: z.string().optional(),
    colorId: z.string().optional(),
    hangoutLink: z.string().optional(),
    conferenceData: z
        .object({
            entryPoints: z
                .array(
                    z.object({ entryPointType: z.string().optional(), uri: z.string().optional() })
                )
                .optional()
        })
        .optional(),
    htmlLink: z.string().optional(),
    eventType: z.string().optional(),
    attachments: z
        .array(
            z.object({
                fileUrl: z.string().optional(),
                title: z.string().optional(),
                mimeType: z.string().optional()
            })
        )
        .optional(),
    sequence: z.number().optional(),
    created: z.string().optional(),
    updated: z.string().optional()
});

export type GoogleEventJson = z.infer<typeof GoogleEvent>;

const EventsPage = z.object({
    items: z.array(GoogleEvent).optional(),
    nextPageToken: z.string().optional(),
    nextSyncToken: z.string().optional()
});

const CalendarListPage = z.object({
    items: z
        .array(
            z.object({
                id: z.string(),
                summary: z.string().optional(),
                summaryOverride: z.string().optional(),
                description: z.string().optional(),
                timeZone: z.string().optional(),
                backgroundColor: z.string().optional(),
                accessRole: z.string().optional(),
                deleted: z.boolean().optional()
            })
        )
        .optional(),
    nextPageToken: z.string().optional()
});

const Colors = z.object({ event: z.record(z.object({ background: z.string() })).optional() });

/** The sync error for a failed Google response, read from its error body. */
async function googleError(response: Response): Promise<Error> {
    let body: unknown = null;
    try {
        body = await readJson(response);
    } catch {
        // An unreadable error body still has a status.
    }
    return errorForProblem(response, readGoogleApiError(response.status, body), {
        name: "Google",
        setup: (problem) => ({
            provider: "google",
            service: problem.service ?? CALENDAR_API.service,
            project: problem.project,
            activationUrl: problem.activationUrl
        })
    });
}

/** Maps the access-token callback's own failure onto the sync errors. */
async function tokenFrom(accessToken: () => Promise<string>): Promise<string> {
    try {
        return await accessToken();
    } catch (error) {
        if (error instanceof SyncError) throw error;
        const text = error instanceof Error ? error.message : "";
        if (/invalid_grant|unauthorized|revoked/i.test(text))
            throw new SyncAuthError("The account's sign-in expired or was revoked", null);
        throw new SyncUnreachableError("Could not refresh the account's sign-in", null);
    }
}

const PARTSTAT_FROM_GOOGLE: Readonly<Record<string, types.PartStat>> = {
    needsAction: "NEEDS-ACTION",
    declined: "DECLINED",
    tentative: "TENTATIVE",
    accepted: "ACCEPTED"
};

const PARTSTAT_TO_GOOGLE: Readonly<Record<string, string>> = {
    "NEEDS-ACTION": "needsAction",
    DECLINED: "declined",
    TENTATIVE: "tentative",
    ACCEPTED: "accepted",
    DELEGATED: "needsAction"
};

const KINDS = new Set(["outOfOffice", "focusTime", "workingLocation"]);

/**
 * The instant a Google `dateTime` names. Google writes an offset, but a value
 * without one is read in the `timeZone` next to it, as the API documents.
 */
function googleInstant(dateTime: string, timeZone: string | undefined): Date {
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(dateTime)) return new Date(dateTime);
    const wall = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/.exec(dateTime)?.[1];
    if (!wall) return new Date(Number.NaN);
    return bridge.toInstant({
        dateTime: wall.length === 16 ? `${wall}:00` : wall,
        tzid: timeZone ?? "UTC"
    });
}

/** A Google start/end as the engine's value, in the zone Google names. */
function fromGoogleTime(
    value: z.infer<typeof EventDateTime> | undefined,
    fallbackZone: string | null
): types.DateValue | null {
    if (!value) return null;
    if (value.date) return { date: value.date };
    if (!value.dateTime) return null;
    const instant = googleInstant(value.dateTime, value.timeZone);
    if (Number.isNaN(instant.getTime())) return null;
    return bridge.wallValue(instant, value.timeZone ?? fallbackZone);
}

/**
 * The engine's value as a Google start/end: the wall time plus the zone to read
 * it in. A floating time, or a zone nothing here resolves, is sent as UTC
 * rather than as a name Google would refuse.
 */
function toGoogleTime(value: types.DateValue): {
    date?: string;
    dateTime?: string;
    timeZone?: string;
} {
    if (bridge.isDate(value)) return { date: value.date };
    const zone = bridge.zoneOrUtc(value.tzid);
    if (value.tzid !== null && zone === "UTC" && !/^(utc|z|gmt)$/i.test(value.tzid)) {
        return {
            dateTime: bridge.wallValue(bridge.toInstant(value), "UTC").dateTime,
            timeZone: "UTC"
        };
    }
    return { dateTime: value.dateTime, timeZone: zone };
}

/** The event palette `colorId` indexes, from Google's own `colors` endpoint. */
type Palette = ReadonlyMap<string, string>;

/** One Google event as an engine event. */
export function googleToEvent(
    event: GoogleEventJson,
    palette: Palette,
    recurrenceId: types.DateValue | null,
    fallbackZone: string | null
): types.CalendarEvent | null {
    const start = fromGoogleTime(event.start, fallbackZone);
    if (!start) return null;
    const end =
        (event.endTimeUnspecified ? null : fromGoogleTime(event.end, fallbackZone)) ?? start;
    const draft = bridge.blankEvent(event.iCalUID ?? event.id, start, end);
    const extra: types.ExtraProperty[] = [];
    draft.recurrenceId = recurrenceId;
    draft.summary = event.summary ?? "";
    draft.description = event.description ?? "";
    draft.location = event.location ?? "";
    draft.status =
        event.status === "tentative"
            ? "TENTATIVE"
            : event.status === "cancelled"
              ? "CANCELLED"
              : event.status === "confirmed"
                ? "CONFIRMED"
                : null;
    draft.transparency = event.transparency === "transparent" ? "TRANSPARENT" : "OPAQUE";
    if (event.visibility === "private") draft.classification = "PRIVATE";
    else if (event.visibility === "confidential") draft.classification = "CONFIDENTIAL";
    else if (event.visibility === "public")
        extra.push({ line: "X-POLARIS-GOOGLE-VISIBILITY:public" });
    if (event.colorId) {
        extra.push({ line: `X-GOOGLE-COLOR-ID:${event.colorId}` });
        draft.color = palette.get(event.colorId) ?? null;
    }
    draft.url = event.htmlLink ?? "";
    if (event.organizer?.email)
        draft.organizer = {
            email: event.organizer.email.toLowerCase(),
            name: event.organizer.displayName ?? ""
        };
    draft.attendees = (event.attendees ?? [])
        .filter((a) => a.email)
        .map((a) => ({
            email: a.email!.toLowerCase(),
            name: a.displayName ?? "",
            role: a.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT",
            partstat: PARTSTAT_FROM_GOOGLE[a.responseStatus ?? ""] ?? "NEEDS-ACTION",
            rsvp: (a.responseStatus ?? "needsAction") === "needsAction",
            type: a.resource ? "RESOURCE" : "INDIVIDUAL"
        }));
    if (event.reminders?.useDefault) extra.push({ line: "X-POLARIS-GOOGLE-DEFAULT-REMINDERS:1" });
    draft.alarms = (event.reminders?.overrides ?? []).map((r) => ({
        action: r.method === "email" ? "EMAIL" : "DISPLAY",
        trigger: { kind: "relative", minutes: -r.minutes, related: "START" },
        description: draft.summary
    }));
    const video = event.conferenceData?.entryPoints?.find(
        (p) => p.entryPointType === "video" && p.uri
    )?.uri;
    draft.conference = video ?? event.hangoutLink ?? "";
    if (event.eventType && KINDS.has(event.eventType))
        draft.kind = event.eventType as types.EventKind;
    draft.attachments = (event.attachments ?? [])
        .filter((a) => a.fileUrl)
        .map((a) => ({ uri: a.fileUrl!, name: a.title ?? "", mime: a.mimeType ?? "" }));
    draft.sequence = event.sequence ?? 0;
    draft.created = bridge.stampOf(event.created);
    draft.lastModified = bridge.stampOf(event.updated);
    if (!recurrenceId && event.recurrence?.length)
        Object.assign(draft, bridge.readRecurrence(event.recurrence, start));
    draft.extra = extra;
    return draft;
}

/** The original start of an exception, in the master's form (date or zone). */
function originalStart(
    exception: GoogleEventJson,
    master: types.CalendarEvent | null
): types.DateValue | null {
    const original = exception.originalStartTime;
    if (!original) return null;
    if (original.date) return { date: original.date };
    if (!original.dateTime) return null;
    const instant = googleInstant(original.dateTime, original.timeZone);
    if (Number.isNaN(instant.getTime())) return null;
    if (master && bridge.isDate(master.start))
        return { date: bridge.wallValue(instant, "UTC").dateTime.slice(0, 10) };
    const zone =
        master && !bridge.isDate(master.start) ? master.start.tzid : (original.timeZone ?? null);
    return bridge.wallValue(instant, zone);
}

/** The etag a grouped object carries: every member's, so a change to any shows. */
function groupEtag(items: readonly GoogleEventJson[]): string {
    const master = items.find((i) => !i.recurringEventId);
    const rest = items.filter((i) => i !== master).sort((a, b) => a.id.localeCompare(b.id));
    return [master, ...rest]
        .filter((i): i is GoogleEventJson => Boolean(i))
        .map((i) => i.etag ?? "")
        .join(",");
}

/**
 * One UID's Google events as one object, or `{ removed }` when nothing of it is
 * left. `href` is the master's id; an exception with no master uses its own.
 */
export function groupToObject(
    items: readonly GoogleEventJson[],
    palette: Palette
): RemoteObject | { removed: string } | null {
    const masterJson = items.find((i) => !i.recurringEventId) ?? null;
    const exceptions = items.filter((i) => i.recurringEventId);
    const href = masterJson?.id ?? exceptions[0]?.recurringEventId ?? exceptions[0]?.id;
    if (!href) return null;
    if (masterJson?.status === "cancelled") return { removed: masterJson.id };
    const master = masterJson ? googleToEvent(masterJson, palette, null, null) : null;
    const zone = master && !bridge.isDate(master.start) ? master.start.tzid : null;
    const overrides: types.CalendarEvent[] = [];
    const exdates: types.DateValue[] = [];
    for (const exception of exceptions) {
        const recurrenceId = originalStart(exception, master);
        if (!recurrenceId) continue;
        if (exception.status === "cancelled") {
            exdates.push(recurrenceId);
            continue;
        }
        const override = googleToEvent(exception, palette, recurrenceId, zone);
        if (override) overrides.push({ ...override, uid: master?.uid ?? override.uid });
    }
    if (!master && overrides.length === 0) return { removed: href };
    const objectHref = master
        ? href
        : (exceptions.find((e) => e.status !== "cancelled")?.id ?? href);
    const finalMaster = master
        ? {
              ...master,
              exdates: [
                  ...master.exdates,
                  ...exdates.filter(
                      (d) => !master.exdates.some((x) => JSON.stringify(x) === JSON.stringify(d))
                  )
              ]
          }
        : null;
    const uid = finalMaster?.uid ?? overrides[0]!.uid;
    return {
        href: objectHref,
        etag: groupEtag(items),
        ics: bridge.writeItem(bridge.eventItem(uid, finalMaster, overrides))
    };
}

/** An engine event as the body of an insert or a patch. */
export function eventToGoogle(
    event: types.CalendarEvent,
    palette: Palette,
    options: { instance: boolean; insert: boolean }
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: toGoogleTime(event.start),
        end: toGoogleTime(event.end),
        transparency: event.transparency === "TRANSPARENT" ? "transparent" : "opaque",
        visibility:
            event.classification === "PRIVATE"
                ? "private"
                : event.classification === "CONFIDENTIAL"
                  ? "confidential"
                  : bridge.extraValue(event, "X-POLARIS-GOOGLE-VISIBILITY") === "public"
                    ? "public"
                    : "default",
        attendees: event.attendees.map((a) => ({
            email: a.email,
            ...(a.name ? { displayName: a.name } : {}),
            ...(a.role === "OPT-PARTICIPANT" ? { optional: true } : {}),
            ...(a.type === "RESOURCE" || a.type === "ROOM" ? { resource: true } : {}),
            responseStatus: PARTSTAT_TO_GOOGLE[a.partstat] ?? "needsAction"
        })),
        attachments: event.attachments.map((a) => ({
            fileUrl: a.uri,
            ...(a.name ? { title: a.name } : {}),
            ...(a.mime ? { mimeType: a.mime } : {})
        }))
    };
    if (event.status) body.status = event.status.toLowerCase();
    const colorId =
        bridge.extraValue(event, "X-GOOGLE-COLOR-ID") ??
        [...palette].find(
            ([, hex]) => event.color && hex.toLowerCase() === event.color.toLowerCase()
        )?.[0];
    // null clears a colour on a patch; an insert simply has none.
    if (colorId) body.colorId = colorId;
    else if (!options.insert) body.colorId = null;
    const popupOrEmail = event.alarms
        .filter(
            (a) =>
                a.trigger.kind === "relative" &&
                a.trigger.related === "START" &&
                a.trigger.minutes <= 0 &&
                a.action !== "AUDIO"
        )
        .slice(0, 5)
        .map((a) => ({
            method: a.action === "EMAIL" ? "email" : "popup",
            minutes: a.trigger.kind === "relative" ? -a.trigger.minutes : 0
        }));
    body.reminders =
        popupOrEmail.length === 0 &&
        bridge.extraValue(event, "X-POLARIS-GOOGLE-DEFAULT-REMINDERS") === "1"
            ? { useDefault: true }
            : { useDefault: false, overrides: popupOrEmail };
    if (!options.instance) {
        const lines = bridge.recurrenceLines(event);
        if (lines.length > 0) body.recurrence = lines;
        else if (!options.insert) body.recurrence = null;
    }
    if (options.insert) body.iCalUID = event.uid;
    return body;
}

/** A Google Calendar account as a `CalendarProvider`. */
export function createGoogleProvider(input: {
    accessToken: () => Promise<string>;
    fetcher: Fetcher;
}): CalendarProvider {
    let palette: Palette | null = null;

    const call = async (
        method: string,
        path: string,
        options: {
            query?: Record<string, string>;
            body?: unknown;
            ifMatch?: string;
            /** The API the path is under: the Calendar API unless said. */
            base?: string;
        } = {}
    ): Promise<Response> => {
        const url = new URL(`${options.base ?? GOOGLE_API}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {}))
            url.searchParams.set(key, value);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${await tokenFrom(input.accessToken)}`,
            Accept: "application/json"
        };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        if (options.ifMatch) headers["If-Match"] = options.ifMatch;
        const { response } = await send(input.fetcher, url.href, {
            method,
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        return response;
    };

    const json = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
        if (!response.ok) throw await googleError(response);
        const parsed = schema.safeParse(await readJson(response));
        if (!parsed.success)
            throw new SyncUnreachableError(
                "Google answered in an unexpected shape",
                response.status
            );
        return parsed.data;
    };

    const loadPalette = async (): Promise<Palette> => {
        if (palette) return palette;
        try {
            const colors = await json(await call("GET", "/colors"), Colors);
            palette = new Map(
                Object.entries(colors.event ?? {}).map(([id, c]) => [
                    id,
                    c.background.toLowerCase()
                ])
            );
        } catch (error) {
            if (error instanceof SyncAuthError || error instanceof SyncSetupError) throw error;
            palette = new Map();
        }
        return palette;
    };

    const calendarPath = (remoteId: string) => `/calendars/${encodeURIComponent(remoteId)}/events`;

    /** Every page of an events listing. */
    const listEvents = async (
        remoteId: string,
        query: Record<string, string>
    ): Promise<{ items: GoogleEventJson[]; nextSyncToken: string }> => {
        const items: GoogleEventJson[] = [];
        let pageToken = "";
        for (let page = 0; page < 1000; page++) {
            const response = await call("GET", calendarPath(remoteId), {
                query: {
                    ...query,
                    showDeleted: "true",
                    singleEvents: "false",
                    maxResults: "2500",
                    ...(pageToken ? { pageToken } : {})
                }
            });
            const data = await json(response, EventsPage);
            items.push(...(data.items ?? []));
            if (data.nextPageToken) {
                pageToken = data.nextPageToken;
                continue;
            }
            return { items, nextSyncToken: data.nextSyncToken ?? "" };
        }
        throw new SyncUnreachableError("Google kept paging without an end", null);
    };

    /** Every event sharing a UID: the master and all its exceptions. */
    const group = (remoteId: string, uid: string) =>
        listEvents(remoteId, { iCalUID: uid }).then((r) => r.items);

    const getEvent = async (remoteId: string, id: string): Promise<GoogleEventJson | null> => {
        const response = await call("GET", `${calendarPath(remoteId)}/${encodeURIComponent(id)}`);
        if (response.status === 404 || response.status === 410) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        return json(response, GoogleEvent);
    };

    const byUid = (items: readonly GoogleEventJson[]): Map<string, GoogleEventJson[]> => {
        const groups = new Map<string, GoogleEventJson[]>();
        for (const item of items) {
            const key = item.iCalUID ?? `id:${item.recurringEventId ?? item.id}`;
            groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        return groups;
    };

    const writeEtag = async (remoteId: string, uid: string, fallback: string): Promise<string> => {
        try {
            const members = await group(remoteId, uid);
            return members.length > 0 ? groupEtag(members) : fallback;
        } catch {
            return fallback;
        }
    };

    // --- Google Tasks: each list one more calendar of the account ----------

    let gaps: ListingGap[] = [];

    const taskCall = (
        method: string,
        path: string,
        options: { query?: Record<string, string>; body?: unknown } = {}
    ) => call(method, path, { ...options, base: tasks.GOOGLE_TASKS_API });

    const listTaskLists = async (): Promise<RemoteCalendar[]> => {
        const lists: RemoteCalendar[] = [];
        let pageToken = "";
        for (let page = 0; page < 20; page++) {
            const response = await taskCall("GET", "/users/@me/lists", {
                query: { maxResults: "1000", ...(pageToken ? { pageToken } : {}) }
            });
            const data = await json(response, tasks.TaskListsPage);
            lists.push(...(data.items ?? []).map(tasks.taskListCalendar));
            if (!data.nextPageToken) return lists;
            pageToken = data.nextPageToken;
        }
        throw new SyncUnreachableError("Google kept paging without an end", null);
    };

    /** Every page of one list's tasks; Google's own ceiling is 20,000 a list. */
    const listTasks = async (
        listId: string,
        query: Record<string, string>
    ): Promise<tasks.GoogleTaskJson[]> => {
        const found: tasks.GoogleTaskJson[] = [];
        let pageToken = "";
        for (let page = 0; page < 300; page++) {
            const response = await taskCall("GET", `/lists/${encodeURIComponent(listId)}/tasks`, {
                query: { ...query, maxResults: "100", ...(pageToken ? { pageToken } : {}) }
            });
            const data = await json(response, tasks.TasksPage);
            found.push(...(data.items ?? []));
            if (!data.nextPageToken) return found;
            pageToken = data.nextPageToken;
        }
        throw new SyncUnreachableError("Google kept paging without an end", null);
    };

    const taskPath = (listId: string, taskId: string) =>
        `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;

    return {
        listingGaps: () => gaps,

        async listCalendars() {
            const calendars = await listEventCalendars();
            // The tasks are an addition to the account, never a reason its
            // calendars stop syncing: an account linked before tasks were asked
            // for, or a project with the Tasks API off, lists its calendars and
            // says what kept the tasks out.
            try {
                const lists = await listTaskLists();
                gaps = [];
                return [...calendars, ...lists];
            } catch (caught) {
                if (caught instanceof SyncAuthError && !(caught instanceof SyncConsentError))
                    throw caught;
                gaps = [{ prefix: tasks.TASKS_PREFIX, cause: caught }];
                return calendars;
            }
        },

        async pull(state): Promise<ChangeSet> {
            const listId = tasks.taskListOf(state.remoteId);
            if (listId !== null)
                return tasks.pullTaskList(state, (query) => listTasks(listId, query));
            return pullEvents(state);
        },

        async put(target, object) {
            const listId = tasks.taskListOf(target.remoteId);
            if (listId === null) return putEvent(target, object);
            const body = tasks.todoToGoogleTask(bridge.readTodo(object.ics));
            // A null clears a field on a patch; a new task simply has none.
            const response = object.href
                ? await taskCall("PATCH", taskPath(listId, object.href), { body })
                : await taskCall("POST", `/lists/${encodeURIComponent(listId)}/tasks`, {
                      body: Object.fromEntries(
                          Object.entries(body).filter(([, value]) => value !== null)
                      )
                  });
            const saved = await json(response, tasks.GoogleTask);
            return { href: saved.id, etag: saved.etag ?? saved.updated ?? "" };
        },

        async remove(target, object) {
            const listId = tasks.taskListOf(target.remoteId);
            if (listId === null) return removeEvent(target, object);
            const response = await taskCall("DELETE", taskPath(listId, object.href));
            if (response.ok || response.status === 404 || response.status === 410) {
                await response.body?.cancel().catch(() => undefined);
                return;
            }
            throw await googleError(response);
        }
    };

    async function listEventCalendars(): Promise<RemoteCalendar[]> {
        const calendars: RemoteCalendar[] = [];
        let pageToken = "";
        for (let page = 0; page < 100; page++) {
            const response = await call("GET", "/users/me/calendarList", {
                query: { maxResults: "250", ...(pageToken ? { pageToken } : {}) }
            });
            const data = await json(response, CalendarListPage);
            for (const entry of data.items ?? []) {
                if (entry.deleted) continue;
                calendars.push({
                    remoteId: entry.id,
                    name: entry.summaryOverride ?? entry.summary ?? entry.id,
                    color: entry.backgroundColor?.toLowerCase() ?? null,
                    description: entry.description ?? "",
                    timezone: entry.timeZone ?? null,
                    readOnly:
                        entry.accessRole === "reader" || entry.accessRole === "freeBusyReader",
                    components: ["VEVENT"]
                });
            }
            if (!data.nextPageToken) return calendars;
            pageToken = data.nextPageToken;
        }
        throw new SyncUnreachableError("Google kept paging without an end", null);
    }

    async function pullEvents(state: PullState): Promise<ChangeSet> {
        const colors = await loadPalette();
        const listing = await listEvents(
            state.remoteId,
            state.syncToken ? { syncToken: state.syncToken } : {}
        );
        const changed: RemoteObject[] = [];
        const removed: string[] = [];

        if (!state.syncToken) {
            for (const items of byUid(listing.items).values()) {
                const object = groupToObject(items, colors);
                if (object && "ics" in object) changed.push(object);
            }
            return { changed, removed, syncToken: listing.nextSyncToken, ctag: "", full: true };
        }

        // Incremental: a change to any part of a series means the whole
        // series is re-read, since the object is stored whole.
        const uids = new Map<string, string>();
        for (const item of listing.items) {
            const inSeries = Boolean(item.recurringEventId || item.recurrence?.length);
            if (item.status === "cancelled" && !item.recurringEventId) {
                removed.push(item.id);
                continue;
            }
            if (!inSeries) {
                const object = groupToObject([item], colors);
                if (object && "ics" in object) changed.push(object);
                else if (object) removed.push(object.removed);
                continue;
            }
            const seriesHref = item.recurringEventId ?? item.id;
            if (item.iCalUID) uids.set(item.iCalUID, seriesHref);
            else if (item.recurringEventId) {
                // A deleted occurrence can arrive with no UID: its master has it.
                const master = await getEvent(state.remoteId, item.recurringEventId);
                if (master?.iCalUID) uids.set(master.iCalUID, seriesHref);
                else removed.push(seriesHref);
            }
        }
        for (const [uid, seriesHref] of uids) {
            const members = await group(state.remoteId, uid);
            const object =
                members.length > 0 ? groupToObject(members, colors) : { removed: seriesHref };
            if (object && "ics" in object) changed.push(object);
            else if (object) removed.push(object.removed);
        }
        const fresh = changed.filter((object) => state.known.get(object.href) !== object.etag);
        return {
            changed: fresh,
            removed: [...new Set(removed)],
            syncToken: listing.nextSyncToken || state.syncToken,
            ctag: "",
            full: false
        };
    }

    async function putEvent(
        target: WriteTarget,
        object: { href: string | null; etag: string | null; ics: string; uid: string }
    ): Promise<{ href: string; etag: string }> {
        const colors = await loadPalette();
        const item = bridge.readEventItem(object.ics, object.uid);
        const master = item.master;
        const everyone = [master, ...item.overrides].filter((e): e is types.CalendarEvent =>
            Boolean(e)
        );
        const sendUpdates = everyone.some((e) => e.attendees.length > 0) ? "all" : "none";
        const query = { sendUpdates, supportsAttachments: "true" };
        const masterEtag = object.etag?.split(",")[0] || undefined;
        let href = object.href;
        let firstEtag = "";

        if (master) {
            let response = href
                ? await call(
                      "PATCH",
                      `${calendarPath(target.remoteId)}/${encodeURIComponent(href)}`,
                      {
                          query,
                          body: eventToGoogle(master, colors, {
                              instance: false,
                              insert: false
                          }),
                          ifMatch: masterEtag
                      }
                  )
                : await call("POST", calendarPath(target.remoteId), {
                      query,
                      body: eventToGoogle(master, colors, { instance: false, insert: true })
                  });
            if (!href && response.status === 409) {
                const existing = (await group(target.remoteId, object.uid)).find(
                    (e) => !e.recurringEventId && e.status !== "cancelled"
                );
                if (existing) {
                    await response.body?.cancel().catch(() => undefined);
                    response = await call(
                        "PATCH",
                        `${calendarPath(target.remoteId)}/${encodeURIComponent(existing.id)}`,
                        {
                            query,
                            body: eventToGoogle(master, colors, {
                                instance: false,
                                insert: false
                            })
                        }
                    );
                }
            }
            const saved = await json(response, GoogleEvent);
            href = saved.id;
            firstEtag = saved.etag ?? "";
        } else if (href) {
            // An exception whose master is not here: it is written as itself.
            const only = item.overrides[0];
            if (only) {
                const response = await call(
                    "PATCH",
                    `${calendarPath(target.remoteId)}/${encodeURIComponent(href)}`,
                    {
                        query,
                        body: eventToGoogle(only, colors, { instance: true, insert: false }),
                        ifMatch: masterEtag
                    }
                );
                firstEtag = (await json(response, GoogleEvent)).etag ?? "";
            }
            return { href, etag: await writeEtag(target.remoteId, object.uid, firstEtag) };
        } else {
            throw new SyncRefusedError("An occurrence cannot be created without its series", null);
        }

        const floating =
            master && !bridge.isDate(master.start) && master.start.tzid ? master.start.tzid : "UTC";
        const etags = [firstEtag];
        for (const override of item.overrides) {
            if (!override.recurrenceId) continue;
            const instanceId = `${href}_${bridge.compactUtc(override.recurrenceId, bridge.zoneOrUtc(floating))}`;
            const response = await call(
                "PATCH",
                `${calendarPath(target.remoteId)}/${encodeURIComponent(instanceId)}`,
                {
                    query,
                    body: eventToGoogle(override, colors, { instance: true, insert: false })
                }
            );
            if (response.status === 404) {
                await response.body?.cancel().catch(() => undefined);
                throw new SyncRefusedError(
                    "A changed occurrence is not part of the series on Google",
                    404
                );
            }
            etags.push((await json(response, GoogleEvent)).etag ?? "");
        }
        return { href, etag: await writeEtag(target.remoteId, object.uid, etags.join(",")) };
    }

    async function removeEvent(
        target: WriteTarget,
        object: { href: string; etag: string | null }
    ): Promise<void> {
        const response = await call(
            "DELETE",
            `${calendarPath(target.remoteId)}/${encodeURIComponent(object.href)}`,
            {
                query: { sendUpdates: "all" },
                ifMatch: object.etag?.split(",")[0] || undefined
            }
        );
        if (response.ok || response.status === 404 || response.status === 410) {
            await response.body?.cancel().catch(() => undefined);
            return;
        }
        throw await googleError(response);
    }
}
