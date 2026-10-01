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
            weekly: { "0": [], "1": [...WORKDAY], "2": [...WORKDAY], "3": [...WORKDAY], "4": [...WORKDAY], "5": [...WORKDAY], "6": [] },
            overrides: {}
        },
        questions: [],
        meetingLink: false,
        enabled: true
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
        questions: page.questions.map((question) => ({ ...question, options: [...question.options] })),
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
    const id = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    return { id, label: "", kind: "short", required: false, options: [] };
}

/** Weekdays in the order the editor lists them: Monday first. */
export const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "0"] as const;

/** A Sunday, so `addDays(SUNDAY, n)` is weekday n for Intl to name. */
export const SUNDAY = "2024-01-07";
