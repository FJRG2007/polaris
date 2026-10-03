/**
 * The booking page editor's form: what a new page starts as, a stored page
 * turned back into the form, and a few words the screens share.
 *
 * Pure: no React, no server.
 */

import type { CalendarSummary } from "../../lib/wire";
import type { BookingPageView } from "../../lib/scheduling-wire";
import type { BookingPageInput, BookingQuestion } from "../../lib/scheduling-schemas";

/** What the form holds: the schema's input, with the slug always a string. */
export type BookingDraft = Omit<BookingPageInput, "slug"> & { readonly slug: string };

const WORKDAY = [{ from: "09:00", to: "17:00" }] as const;

/** A new page: weekdays nine to five, half-hour meetings, in the reader's zone. */
export function newDraft(zone: string, calendarId: string): BookingDraft {
    return {
        title: "",
        slug: "",
        description: "",
        location: "",
        visibility: "link",
        calendarId,
        conflictIds: [],
        durationMinutes: 30,
        slotMinutes: 30,
        bufferBefore: 0,
        bufferAfter: 0,
        noticeMinutes: 240,
        maxPerDay: null,
        horizonDays: 60,
        timezone: zone,
        availability: {
            weekly: {
                "0": [],
                "1": [...WORKDAY],
                "2": [...WORKDAY],
                "3": [...WORKDAY],
                "4": [...WORKDAY],
                "5": [...WORKDAY],
                "6": []
            },
            overrides: {}
        },
        questions: [],
        meetingLink: false,
        enabled: true
    };
}

/** What the calendar's quick card hands a new page: its title, and the time
 *  picked on the grid as the hours it is open. */
export interface BookingSeed {
    readonly title: string;
    /** `YYYY-MM-DD` of the day picked; its weekday is the day the page is open. */
    readonly day: string | null;
    /** `HH:mm` the picked range starts and ends; null for a whole day. */
    readonly from: string | null;
    readonly to: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutesOf(time: string): number {
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** The seed a booking page link carries, read strictly: anything malformed is
 *  left out rather than guessed at. */
export function seedOf(
    query: Readonly<Record<string, string | string[] | undefined>>
): BookingSeed {
    const one = (key: string) => {
        const value = query[key];
        const first = Array.isArray(value) ? value[0] : value;
        return typeof first === "string" ? first : null;
    };
    const day = one("day");
    const from = one("from");
    const to = one("to");
    const timed = from !== null && to !== null && TIME.test(from) && TIME.test(to);
    return {
        title: (one("title") ?? "").trim().slice(0, 200),
        day: day && DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? day : null,
        from: timed && minutesOf(from) < minutesOf(to) ? from : null,
        to: timed && minutesOf(from) < minutesOf(to) ? to : null
    };
}

/** A new page started from the seed: its title, and - when a time was picked -
 *  open that weekday for those hours only, with meetings no longer than them. */
export function seededDraft(draft: BookingDraft, seed: BookingSeed): BookingDraft {
    const titled = seed.title ? { ...draft, title: seed.title } : draft;
    if (!seed.day || !seed.from || !seed.to) return titled;
    const weekday = String(new Date(`${seed.day}T12:00:00Z`).getUTCDay());
    const length = minutesOf(seed.to) - minutesOf(seed.from);
    const weekly = Object.fromEntries(
        Object.keys(draft.availability.weekly).map((day) => [
            day,
            day === weekday ? [{ from: seed.from!, to: seed.to! }] : []
        ])
    ) as BookingDraft["availability"]["weekly"];
    const duration = Math.max(5, Math.min(draft.durationMinutes, length));
    return {
        ...titled,
        durationMinutes: duration,
        slotMinutes: Math.max(5, Math.min(draft.slotMinutes, length)),
        availability: { ...draft.availability, weekly }
    };
}

/** A stored page as the form edits it. */
export function draftOf(page: BookingPageView): BookingDraft {
    return {
        title: page.title,
        slug: page.slug,
        description: page.description,
        location: page.location,
        visibility: page.visibility,
        calendarId: page.calendarId,
        conflictIds: [...page.conflictIds],
        durationMinutes: page.durationMinutes,
        slotMinutes: page.slotMinutes,
        bufferBefore: page.bufferBefore,
        bufferAfter: page.bufferAfter,
        noticeMinutes: page.noticeMinutes,
        maxPerDay: page.maxPerDay,
        horizonDays: page.horizonDays,
        timezone: page.timezone,
        availability: JSON.parse(JSON.stringify(page.availability)) as BookingDraft["availability"],
        questions: page.questions.map((question) => ({
            ...question,
            options: [...question.options]
        })),
        meetingLink: page.meetingLink,
        enabled: page.enabled
    };
}

/** What the actions are sent: the form, without an empty slug. */
export function inputOf(draft: BookingDraft): unknown {
    const { slug, ...rest } = draft;
    return slug.trim() ? { ...rest, slug } : rest;
}

/** Calendars a booking can be written into. */
export function writableCalendars(calendars: readonly CalendarSummary[]): CalendarSummary[] {
    return calendars.filter((calendar) => calendar.writable && calendar.kind !== "resource");
}

/** A fresh question id: eight lowercase letters and digits. */
export function newQuestion(): BookingQuestion {
    const id = Array.from(
        { length: 8 },
        () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
    ).join("");
    return { id, label: "", kind: "short", required: false, options: [] };
}

/** Weekdays in the order the editor lists them: Monday first. */
export const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "0"] as const;

/** A Sunday, so `addDays(SUNDAY, n)` is weekday n for Intl to name. */
export const SUNDAY = "2024-01-07";
