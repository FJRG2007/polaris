/**
 * Calendars in and out as files: importing an .ics (or jCal) into a calendar,
 * and exporting a calendar or one event as .ics.
 *
 * An import writes each event through `writeItem` like any other change, so a
 * provider calendar receives what is imported into it and reminders are
 * planned. An event whose UID the calendar already holds is skipped rather than
 * overwritten: importing the same file twice must not undo edits made since.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf, writeItem } from "./objects";
import { host } from "@polaris/app-host";
import { CalendarRefusal } from "./errors";
import { calendarT, ruleTIn } from "./i18n";
import { createCalendar } from "./calendars";
import {
    forReader,
    reaches,
    requireCalendar,
    requireWritableCalendar,
    type SessionUser
} from "./access";

/** Events one import may bring in. A decade of somebody's work calendar is a
 *  few thousand; more than this is a file that is not a calendar. */
const MAX_IMPORT = 20_000;

export interface ImportResult {
    readonly calendarId: string;
    readonly imported: number;
    readonly skipped: number;
    /** One sentence per component that could not be read. */
    readonly problems: readonly string[];
}

export async function importCalendar(
    user: SessionUser,
    input: {
        target:
            | { kind: "existing"; calendarId: string }
            | { kind: "new"; name: string; color: string };
        text: string;
        floatingZone: string;
    }
): Promise<ImportResult> {
    const parsed = engine.parseCalendarText(input.text);
    const t = await calendarT();
    if (parsed.items.length === 0 && parsed.errors.length === 0)
        throw new CalendarRefusal(t("errors.emptyImport"));
    if (parsed.items.length > MAX_IMPORT) throw new CalendarRefusal(t("errors.importTooLarge"));

    const calendarId =
        input.target.kind === "existing"
            ? (await requireWritableCalendar(user.id, input.target.calendarId)).id
            : await createCalendar(user, {
                  name: input.target.name,
                  color: input.target.color,
                  description: "",
                  timezone: parsed.timezone ?? "",
                  components: parsed.items.some((item) => item.component === "VTODO")
                      ? "VEVENT,VTODO"
                      : "VEVENT"
              });

    const held = new Set(
        (
            await prisma.calendarObject.findMany({
                where: { calendarId, uid: { in: parsed.items.map((item) => item.uid) } },
                select: { uid: true }
            })
        ).map((row) => row.uid)
    );
    let imported = 0;
    let skipped = 0;
    for (const item of parsed.items) {
        if (held.has(item.uid)) {
            skipped += 1;
            continue;
        }
        // An import is a copy, not a scheduling message: a METHOD from an
        // invitation file is dropped so the event is stored as an event.
        await writeItem(
            calendarId,
            null,
            { ...item, method: null },
            {
                actor: user,
                floatingZone: input.floatingZone,
                fromImport: true
            }
        );
        held.add(item.uid);
        imported += 1;
    }
    const words = ruleTIn(await host.i18nRequest.getLocale());
    const problems = (parsed.problems ?? parsed.errors.map((key) => ({ key, values: {} }))).map(
        (problem) =>
            words.has(problem.key)
                ? words(problem.key, problem.values as never)
                : t("errors.unreadableEvent")
    );
    return { calendarId, imported, skipped, problems: problems.slice(0, 50) };
}

/**
 * Many stored resources as one VCALENDAR: their components in order, each
 * VTIMEZONE once. Works on the stored text so nothing the engine does not
 * model is lost on the way out.
 */
export function combineCalendars(
    texts: readonly string[],
    header: { name: string; color: string | null; timezone: string | null }
): string {
    const zones = new Map<string, string[]>();
    const components: string[][] = [];
    for (const text of texts) {
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        let depth = 0;
        let current: string[] | null = null;
        let zoneId: string | null = null;
        for (const line of lines) {
            if (/^BEGIN:VCALENDAR$/i.test(line)) continue;
            if (/^END:VCALENDAR$/i.test(line)) break;
            if (depth === 0 && !/^BEGIN:/i.test(line)) continue;
            if (/^BEGIN:/i.test(line)) {
                if (depth === 0) {
                    current = [];
                    zoneId = null;
                }
                depth += 1;
            }
            current?.push(line);
            if (
                depth === 1 &&
                current?.[0] &&
                /^BEGIN:VTIMEZONE$/i.test(current[0]) &&
                /^TZID[:;]/i.test(line)
            ) {
                zoneId = line.slice(line.indexOf(":") + 1);
            }
            if (/^END:/i.test(line)) {
                depth -= 1;
                if (depth === 0 && current) {
                    if (/^BEGIN:VTIMEZONE$/i.test(current[0] ?? "")) {
                        if (zoneId && !zones.has(zoneId)) zones.set(zoneId, current);
                    } else {
                        components.push(current);
                    }
                    current = null;
                }
            }
        }
    }
    const out = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        `PRODID:${engine.DEFAULT_PRODID}`,
        "CALSCALE:GREGORIAN",
        engine.foldLine(`X-WR-CALNAME:${escapeText(header.name)}`),
        engine.foldLine(`NAME:${escapeText(header.name)}`),
        ...(header.color
            ? [`X-APPLE-CALENDAR-COLOR:${header.color}`, `COLOR:${header.color}`]
            : []),
        ...(header.timezone ? [`X-WR-TIMEZONE:${header.timezone}`] : []),
        ...[...zones.values()].flat(),
        ...components.flat(),
        "END:VCALENDAR"
    ];
    return `${out.join("\r\n")}\r\n`;
}

function escapeText(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\n/g, "\\n");
}

/** What a reader below `write` may take of a stored resource: what the
 *  calendar shows them, or null when it shows them nothing of it. */
function readerCopy(ics: string): string | null {
    const item = tryItemOf(ics);
    const visible = item ? forReader(item) : null;
    return visible ? engine.serializeItem(visible) : null;
}

/** A calendar this person may read, as one file: everything for whoever may
 *  change it, and what the calendar view shows for a reader. A free/busy
 *  reader gets nothing. */
export async function exportCalendar(
    user: SessionUser,
    calendarId: string
): Promise<{ name: string; ics: string }> {
    const calendar = await requireCalendar(user.id, calendarId, "read");
    return reaches(calendar.reach, "write")
        ? exportCalendarRow(calendar.id)
        : exportCalendarRow(calendar.id, readerCopy);
}

/** The export of a calendar by id, with no reader check - for the public feed,
 *  which checked its token instead. */
export async function exportCalendarRow(
    calendarId: string,
    filter: (ics: string) => string | null = (ics) => ics
): Promise<{ name: string; ics: string }> {
    const calendar = await prisma.calendar.findUnique({
        where: { id: calendarId },
        select: { name: true, color: true, timezone: true }
    });
    if (!calendar) throw new CalendarRefusal((await calendarT())("errors.calendarNotFound"));
    const rows = await prisma.calendarObject.findMany({
        where: { calendarId, deletedAt: null },
        select: { ics: true },
        orderBy: { startsAt: "asc" }
    });
    const texts = rows
        .map((row) => filter(row.ics))
        .filter((text): text is string => text !== null);
    return {
        name: calendar.name,
        ics: combineCalendars(texts, {
            name: calendar.name,
            color: calendar.color,
            timezone: calendar.timezone || null
        })
    };
}

/** One event as a file. */
export async function exportEvent(
    user: SessionUser,
    objectId: string
): Promise<{ name: string; ics: string }> {
    const row = await prisma.calendarObject.findUnique({
        where: { id: objectId },
        select: { calendarId: true, ics: true, summary: true, deletedAt: true }
    });
    if (!row || row.deletedAt)
        throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));
    const calendar = await requireCalendar(user.id, row.calendarId, "read");
    if (reaches(calendar.reach, "write")) return { name: row.summary || "event", ics: row.ics };
    const ics = readerCopy(row.ics);
    if (!ics) throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));
    const shown = tryItemOf(ics);
    const name =
        shown?.component === "VEVENT"
            ? (shown.master ?? shown.overrides[0])?.summary
            : shown?.todo.summary;
    return { name: name || "event", ics };
}

/** A file name for a download: letters, digits, dashes, and the extension. */
export function fileName(name: string, extension: string): string {
    const safe = name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return `${safe || "calendar"}.${extension}`;
}
