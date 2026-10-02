/**
 * Events and tasks as stored: one row per iCalendar resource, the text the
 * source of truth, and the columns beside it derived from it on every write.
 *
 * Every change goes through `writeItem`, which is what keeps the derived
 * columns, the reminders, the invitations and - for a calendar synced from a
 * provider - the provider itself in step with the text. There is no second
 * write path, on purpose.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { CalendarRefusal } from "./errors";
import { afterObjectChange } from "./effects";
import { reaches, requireCalendar, requireWritableCalendar, type SessionUser } from "./access";

/** The row a write starts from. */
export interface StoredObject {
    readonly id: string;
    readonly calendarId: string;
    readonly uid: string;
    readonly component: string;
    readonly ics: string;
    readonly href: string;
    readonly etag: string;
    readonly updatedAt: Date;
    readonly deletedAt: Date | null;
}

const STORED = {
    id: true,
    calendarId: true,
    uid: true,
    component: true,
    ics: true,
    href: true,
    etag: true,
    updatedAt: true,
    deletedAt: true
} as const;

/** The version a screen sends back: when the row last changed. */
export function versionOf(row: { updatedAt: Date }): string {
    return row.updatedAt.toISOString();
}

/**
 * The one item a stored row holds. A row that no longer parses is a refusal
 * rather than a crash - it came from a provider, and one bad event must not
 * take the calendar down with it.
 */
export async function itemOf(row: { ics: string }): Promise<engine.CalendarItem> {
    const parsed = engine.parseCalendarText(row.ics);
    const item = parsed.items[0];
    if (!item) throw new CalendarRefusal((await calendarT())("errors.unreadableEvent"));
    return item;
}

/** A parsed item or null, for readers that skip what they cannot read. */
export function tryItemOf(ics: string): engine.CalendarItem | null {
    try {
        return engine.parseCalendarText(ics).items[0] ?? null;
    } catch {
        return null;
    }
}

/** The columns derived from an item. */
function derived(item: engine.CalendarItem, floatingZone: string) {
    const bounds = engine.itemBounds(item, floatingZone);
    return {
        uid: item.uid,
        component: item.component,
        summary: bounds.summary.slice(0, 500),
        location: bounds.location.slice(0, 1000),
        startsAt: bounds.startsAt,
        endsAt: bounds.endsAt,
        allDay: bounds.allDay,
        recurring: bounds.recurring,
        status: bounds.status
    };
}

export interface WriteContext {
    /** Who is writing, for invitations and the record. Null for a sync. */
    readonly actor: SessionUser | null;
    /** The zone floating times are read in. */
    readonly floatingZone: string;
    /** Whether this write came from the provider (a pull), so it must not be
     *  pushed back to it, nor send invitations the provider already sent. */
    readonly fromProvider?: boolean;
    /** Brought in from a file: stored, planned, pushed to a provider - but a
     *  file is a copy, so nobody in it is sent an invitation. */
    readonly fromImport?: boolean;
    /** The object is leaving this calendar for another: its provider copy goes,
     *  but nobody is told the event was cancelled. */
    readonly moving?: boolean;
    /** The write is somebody answering an invitation: the organizer hears back. */
    readonly reply?: {
        readonly email: string;
        readonly partstat: engine.PartStat;
        readonly recurrenceKey: string | null;
    };
}

/**
 * Store an item - new or replacing a row - and bring everything that depends on
 * it in step. Returns the row id.
 */
export async function writeItem(
    calendarId: string,
    previous: StoredObject | null,
    item: engine.CalendarItem,
    context: WriteContext
): Promise<string> {
    // A change made here is stamped now (DTSTAMP is when the object last
    // changed, and clients compare it); what came from a provider or a file
    // keeps the stamp it arrived with.
    const ics = engine.serializeItem(
        item,
        context.fromProvider || context.fromImport ? {} : { now: new Date() }
    );
    const columns = derived(item, context.floatingZone);
    const before = previous ? tryItemOf(previous.ics) : null;
    const row = previous
        ? await prisma.calendarObject.update({
              where: { id: previous.id },
              data: { ...columns, ics, deletedAt: null },
              select: { id: true }
          })
        : await prisma.calendarObject.create({
              data: { ...columns, calendarId, ics },
              select: { id: true }
          });
    await afterObjectChange({
        objectId: row.id,
        calendarId,
        before,
        after: item,
        context
    });
    return row.id;
}

/** One stored object this person may write, and its calendar. */
export async function writableObject(user: SessionUser, objectId: string, version?: string) {
    const row = await prisma.calendarObject.findUnique({ where: { id: objectId }, select: STORED });
    const t = await calendarT();
    if (!row || row.deletedAt) throw new CalendarRefusal(t("errors.eventNotFound"));
    const calendar = await requireWritableCalendar(user.id, row.calendarId);
    if (version && version !== versionOf(row))
        throw new CalendarRefusal(t("errors.changedMeanwhile"));
    return { row, calendar };
}

/** One stored object this person may read. */
export async function readableObject(user: SessionUser, objectId: string) {
    const row = await prisma.calendarObject.findUnique({ where: { id: objectId }, select: STORED });
    if (!row || row.deletedAt)
        throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));
    const calendar = await requireCalendar(user.id, row.calendarId, "freebusy");
    return { row, calendar };
}

/** The organizer a new event from this person carries. */
function organizerFor(user: SessionUser): engine.Person {
    return { email: user.email.toLowerCase(), name: user.name };
}

/**
 * The event an editor's input describes, on top of what it replaces so every
 * property the editor does not show - Google's colour id, Apple's travel time,
 * an attachment - survives the edit.
 */
export function eventFromInput(
    input: engine.EventInput,
    base: engine.CalendarEvent | null,
    organizer: engine.Person | null
): engine.CalendarEvent {
    const rule =
        input.keepRule && base?.rule
            ? base.rule
            : input.rule
              ? engine.ruleFromEditor(input.rule, input.start)
              : null;
    const hasAttendees = input.attendees.length > 0;
    const fields: Partial<engine.CalendarEvent> & {
        start: engine.CalendarEvent["start"];
        end: engine.CalendarEvent["end"];
    } = {
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        status: input.status,
        transparency: input.transparency,
        classification: input.classification,
        categories: input.categories,
        color: input.color,
        url: input.url,
        conference: input.conference,
        kind: input.kind,
        alarms: input.alarms,
        attachments: input.attachments.map((attachment) => {
            // What the provider knew about a file (its size, its id at Google)
            // stays with it when the editor sends the same link back.
            const known = base?.attachments.find((existing) => existing.uri === attachment.uri);
            return known
                ? { ...known, name: attachment.name, mime: attachment.mime || known.mime }
                : attachment;
        }),
        attendees: input.attendees.map((attendee) => {
            // An answer is the attendee's, never the editor's: keep what they said.
            const known = base?.attendees.find((existing) => existing.email === attendee.email);
            return { ...attendee, partstat: known?.partstat ?? attendee.partstat };
        }),
        organizer: hasAttendees ? (base?.organizer ?? organizer) : (base?.organizer ?? null),
        rule
    };
    return base ? { ...base, ...fields } : engine.newEvent(fields);
}

export interface SaveEventInput {
    readonly objectId: string | null;
    readonly recurrenceKey: string | null;
    readonly scope: engine.EditScope;
    readonly version: string | null;
    readonly event: engine.EventInput;
    readonly floatingZone: string;
}

/**
 * Create or change an event. Moving it to another calendar is part of the same
 * save: the row moves, and a provider calendar on either side is told.
 */
export async function saveEvent(
    user: SessionUser,
    input: SaveEventInput
): Promise<{ objectId: string }> {
    const context: WriteContext = { actor: user, floatingZone: input.floatingZone };
    const target = await requireWritableCalendar(user.id, input.event.calendarId);
    if (!input.objectId) {
        const item = engine.eventItem(eventFromInput(input.event, null, organizerFor(user)));
        return { objectId: await writeItem(target.id, null, item, context) };
    }

    const { row } = await writableObject(user, input.objectId, input.version ?? undefined);
    const item = await itemOf(row);
    if (item.component !== "VEVENT")
        throw new CalendarRefusal((await calendarT())("errors.notAnEvent"));
    const base =
        (input.recurrenceKey
            ? item.overrides.find((override) => overrideKeyMatches(override, input.recurrenceKey!))
            : null) ??
        item.master ??
        item.overrides[0] ??
        null;
    const next = eventFromInput(input.event, base, organizerFor(user));
    const scope = item.master?.rule || item.master?.rdates.length ? input.scope : "all";
    const edited = engine.applyEdit(item, input.recurrenceKey, next, scope, input.floatingZone);

    if (row.calendarId !== target.id && scope === "all") {
        return { objectId: await moveObject(user, row, target.id, edited.item, context) };
    }
    await writeItem(row.calendarId, row, edited.item, context);
    if (edited.split) await writeItem(row.calendarId, null, edited.split, context);
    return { objectId: row.id };
}

/** Whether an override is the occurrence a key names. The engine keys by the
 *  original start; an override's RECURRENCE-ID is that start. */
function overrideKeyMatches(override: engine.CalendarEvent, key: string): boolean {
    const id = override.recurrenceId;
    if (!id) return false;
    if ("date" in id) return id.date === key;
    return key.startsWith(id.dateTime.slice(0, 10)) || id.dateTime === key;
}

/**
 * Move a whole object to another calendar: removed from where it was (and from
 * that provider), written into the new one (and to its provider) under the same
 * UID, so invitations already sent still point at it.
 *
 * The row itself moves - same id, same invitation rows and answer links - and
 * is written as a change from what it was, so the people invited hear only
 * what changed, not a second invitation. Answers the row id.
 */
async function moveObject(
    user: SessionUser,
    row: StoredObject,
    targetCalendarId: string,
    item: engine.CalendarItem,
    context: WriteContext
): Promise<string> {
    const clash = await prisma.calendarObject.findUnique({
        where: { calendarId_uid: { calendarId: targetCalendarId, uid: row.uid } },
        select: { id: true }
    });
    if (clash) throw new CalendarRefusal((await calendarT())("errors.alreadyThere"));
    await removeObject(row, context);
    // The old provider's copy is deleted from the row as it still stands there;
    // after the move the row no longer says where that copy was.
    const from = await prisma.calendar.findUnique({
        where: { id: row.calendarId },
        select: { sourceId: true }
    });
    if (from?.sourceId) {
        const sync = await import("./sync-engine");
        await sync
            .pushNow(row.id, from.sourceId)
            .catch((caught: unknown) =>
                console.error("polaris: a moved event was not removed from its provider:", caught)
            );
    }
    await prisma.calendarObject.update({
        where: { id: row.id },
        data: {
            calendarId: targetCalendarId,
            href: "",
            etag: "",
            pendingPush: "",
            conflictIcs: null
        }
    });
    return writeItem(
        targetCalendarId,
        { ...row, calendarId: targetCalendarId, href: "", etag: "" },
        item,
        { ...context, actor: user }
    );
}

/** Drag or resize: move an occurrence (or its series) by whole milliseconds. */
export async function shiftEvent(
    user: SessionUser,
    input: {
        objectId: string;
        recurrenceKey: string | null;
        startDeltaMs: number;
        endDeltaMs: number;
        scope: engine.EditScope;
        version: string | null;
        floatingZone: string;
    }
): Promise<void> {
    const { row } = await writableObject(user, input.objectId, input.version ?? undefined);
    const item = await itemOf(row);
    const edited = engine.shiftOccurrence(
        item,
        input.recurrenceKey,
        input.startDeltaMs,
        input.endDeltaMs,
        input.scope,
        input.floatingZone
    );
    const context: WriteContext = { actor: user, floatingZone: input.floatingZone };
    await writeItem(row.calendarId, row, edited.item, context);
    if (edited.split) await writeItem(row.calendarId, null, edited.split, context);
}

/**
 * Delete an occurrence, the following ones, or the whole object. The whole
 * object goes to the trash; its provider copy is deleted at once, since a trash
 * that kept a remote meeting alive would keep inviting people to it.
 */
export async function deleteEvent(
    user: SessionUser,
    input: {
        objectId: string;
        recurrenceKey: string | null;
        scope: engine.EditScope;
        floatingZone: string;
    }
): Promise<void> {
    const { row } = await writableObject(user, input.objectId);
    const item = await itemOf(row);
    const context: WriteContext = { actor: user, floatingZone: input.floatingZone };
    const remaining =
        input.recurrenceKey && input.scope !== "all"
            ? engine.deleteOccurrences(item, input.recurrenceKey, input.scope, input.floatingZone)
            : null;
    if (remaining) {
        await writeItem(row.calendarId, row, remaining, context);
        return;
    }
    await trashObject(row, item, context);
}

/** Put a whole object in the trash and tell everything that depends on it. */
export async function trashObject(
    row: StoredObject,
    item: engine.CalendarItem,
    context: WriteContext
): Promise<void> {
    await prisma.calendarObject.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
    await afterObjectChange({
        objectId: row.id,
        calendarId: row.calendarId,
        before: item,
        after: null,
        context
    });
}

/** Remove an object from its provider (and its reminders), for a move. */
async function removeObject(row: StoredObject, context: WriteContext): Promise<void> {
    await afterObjectChange({
        objectId: row.id,
        calendarId: row.calendarId,
        before: tryItemOf(row.ics),
        after: null,
        context: { ...context, moving: true }
    });
}

/** A copy of an event, in the same calendar, with a new UID and nobody invited
 *  yet - a copy that re-sent the original's invitations would be a surprise. */
export async function duplicateEvent(
    user: SessionUser,
    objectId: string,
    floatingZone: string
): Promise<string> {
    const { row } = await writableObject(user, objectId);
    const copy = engine.duplicateItem(await itemOf(row));
    // Stored the way a file is: nobody listed in it is sent an invitation.
    return writeItem(row.calendarId, null, copy, { actor: user, floatingZone, fromImport: true });
}

/**
 * Paste a copied occurrence: one new event (never a series) with everything the
 * occurrence had, at the start and end given, in a calendar the reader writes
 * to. Copying needs only to read the original - an event from a calendar shared
 * read-only can be pasted into one's own. Stored the way a duplicate is, so
 * nobody listed on it is sent an invitation.
 */
export async function pasteEvent(
    user: SessionUser,
    input: {
        objectId: string;
        recurrenceKey: string | null;
        calendarId: string;
        start: engine.DateValue;
        end: engine.DateValue;
        floatingZone: string;
    }
): Promise<string> {
    const t = await calendarT();
    const row = await prisma.calendarObject.findUnique({
        where: { id: input.objectId },
        select: STORED
    });
    if (!row || row.deletedAt) throw new CalendarRefusal(t("errors.eventNotFound"));
    const source = await requireCalendar(user.id, row.calendarId, "read");
    const target = await requireWritableCalendar(user.id, input.calendarId);
    const item = await itemOf(row);
    if (item.component !== "VEVENT") throw new CalendarRefusal(t("errors.notAnEvent"));
    const base =
        (input.recurrenceKey
            ? item.overrides.find((override) => overrideKeyMatches(override, input.recurrenceKey!))
            : null) ??
        item.master ??
        item.overrides[0];
    if (!base) throw new CalendarRefusal(t("errors.notAnEvent"));
    if (!reaches(source.reach, "write") && base.classification !== "PUBLIC")
        throw new CalendarRefusal(t("errors.busyOnly"));
    const {
        uid: _uid,
        recurrenceId: _recurrenceId,
        thisAndFuture: _thisAndFuture,
        rule: _rule,
        exdates: _exdates,
        rdates: _rdates,
        sequence: _sequence,
        created: _created,
        lastModified: _lastModified,
        ...kept
    } = base;
    const copy = engine.newEvent({ ...kept, start: input.start, end: input.end });
    return writeItem(target.id, null, engine.eventItem(copy, item.timezones), {
        actor: user,
        floatingZone: input.floatingZone,
        fromImport: true
    });
}

/**
 * Move a whole event - every occurrence - to another calendar the reader writes
 * to, the way the editor's calendar picker does on a save of the series.
 */
export async function moveEvent(
    user: SessionUser,
    input: { objectId: string; calendarId: string; floatingZone: string }
): Promise<string> {
    const { row } = await writableObject(user, input.objectId);
    const target = await requireWritableCalendar(user.id, input.calendarId);
    if (row.calendarId === target.id) return row.id;
    const item = await itemOf(row);
    return moveObject(user, row, target.id, item, {
        actor: user,
        floatingZone: input.floatingZone
    });
}

/**
 * Colour a whole event (RFC 7986 COLOR on the series and every override), or
 * give it back the calendar's colour with null.
 */
export async function setEventColor(
    user: SessionUser,
    input: { objectId: string; color: string | null; floatingZone: string }
): Promise<void> {
    const { row } = await writableObject(user, input.objectId);
    const item = await itemOf(row);
    if (item.component !== "VEVENT")
        throw new CalendarRefusal((await calendarT())("errors.notAnEvent"));
    const color = input.color;
    await writeItem(
        row.calendarId,
        row,
        {
            ...item,
            master: item.master ? { ...item.master, color } : null,
            overrides: item.overrides.map((override) => ({ ...override, color }))
        },
        { actor: user, floatingZone: input.floatingZone }
    );
}

/**
 * Answer an invitation as the person reading it: their PARTSTAT on the
 * occurrence or the series. Reaching the calendar at all is enough - an
 * attendee answers their own invitation on a calendar shared to them read-only.
 */
export async function respondToEvent(
    user: SessionUser,
    input: {
        objectId: string;
        recurrenceKey: string | null;
        partstat: engine.PartStat;
        emails: readonly string[];
        floatingZone: string;
    }
): Promise<void> {
    const { row, calendar } = await readableObject(user, input.objectId);
    if (calendar.readOnly) throw new CalendarRefusal((await calendarT())("errors.readOnly"));
    const item = await itemOf(row);
    if (item.component !== "VEVENT")
        throw new CalendarRefusal((await calendarT())("errors.notAnEvent"));
    const events = [item.master, ...item.overrides].filter((event): event is engine.CalendarEvent =>
        Boolean(event)
    );
    const email = input.emails.find((address) =>
        events.some((event) => event.attendees.some((attendee) => attendee.email === address))
    );
    if (!email) throw new CalendarRefusal((await calendarT())("errors.notInvited"));
    const answered = engine.setAttendeeStatus(
        item,
        email,
        input.partstat,
        input.recurrenceKey,
        input.floatingZone
    );
    await writeItem(row.calendarId, row, answered, {
        actor: user,
        floatingZone: input.floatingZone,
        reply: { email, partstat: input.partstat, recurrenceKey: input.recurrenceKey }
    });
}

/** Ids of the objects a calendar holds that are not in the trash. */
export async function liveObjectIds(calendarId: string): Promise<string[]> {
    const rows = await prisma.calendarObject.findMany({
        where: { calendarId, deletedAt: null },
        select: { id: true }
    });
    return rows.map((row) => row.id);
}
