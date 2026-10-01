/**
 * What the Calendar's server hands its screens: plain JSON shapes, the contract
 * between `src/actions`, `src/routes/api` and `src/screens`. Instants travel as
 * ISO strings; all-day values as `YYYY-MM-DD`.
 *
 * Pure types.
 */

import type {
    Alarm,
    Attendee,
    CalendarEvent,
    CalendarTodo,
    EventKind,
    PartStat,
    Person
} from "../engine/types";
import type { Reach } from "./access";

/** Where a calendar comes from. */
export type SourceKind = "google" | "microsoft" | "caldav" | "ics";

/** What a room or a piece of equipment is, for the room picker. */
export interface ResourceInfo {
    readonly type: "room" | "equipment";
    readonly capacity: number | null;
    readonly building: string;
    readonly floor: string;
    readonly features: readonly string[];
}

/** Minutes relative to the start, for new timed and all-day events. */
export interface DefaultAlarms {
    readonly timed: readonly number[];
    readonly allDay: readonly number[];
}

/** One calendar in the sidebar, from the reader's side. */
export interface CalendarSummary {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** The reader's colour for it - their own choice, or the calendar's. */
    readonly color: string;
    /** The calendar's own colour, which only the owner or a manager changes. */
    readonly ownColor: string;
    readonly timezone: string;
    readonly components: readonly ("VEVENT" | "VTODO")[];
    readonly kind: "local" | "remote" | "resource" | "birthdays";
    readonly source: {
        readonly id: string;
        readonly kind: SourceKind;
        readonly label: string;
        readonly status: string;
        readonly lastSyncAt: string | null;
    } | null;
    readonly reach: Reach;
    /** Who it belongs to, when that is not the reader. */
    readonly owner: { readonly id: string; readonly name: string } | null;
    readonly hidden: boolean;
    readonly position: number;
    /** Events can be written into it by this reader. */
    readonly writable: boolean;
    readonly transparent: boolean;
    readonly alarmsMuted: boolean;
    readonly defaultAlarms: DefaultAlarms;
    readonly publicMode: "" | "busy" | "full";
    readonly publicToken: string | null;
    readonly resource: ResourceInfo | null;
    readonly shareCount: number;
}

/** One drawn occurrence. */
export interface OccurrenceView {
    readonly objectId: string;
    readonly calendarId: string;
    readonly uid: string;
    /** The occurrence's original start: what an edit of just this one names. */
    readonly recurrenceKey: string;
    readonly start: string;
    readonly end: string;
    readonly allDay: boolean;
    readonly startDate: string | null;
    readonly endDate: string | null;
    /** Empty when the reader may only see that the time is taken. */
    readonly summary: string;
    readonly location: string;
    readonly color: string | null;
    readonly status: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | null;
    readonly transparent: boolean;
    readonly recurring: boolean;
    readonly overridden: boolean;
    readonly kind: EventKind;
    readonly attendeeCount: number;
    /** The reader's own answer, when they are invited. */
    readonly myPartstat: PartStat | null;
    readonly hasAlarms: boolean;
    readonly busyOnly: boolean;
    readonly editable: boolean;
    readonly conference: string;
    readonly categories: readonly string[];
}

/** A task drawn on the calendar: from the Tasks app, or a VTODO from a calendar. */
export interface TaskItemView {
    readonly source: "tasks" | "calendar";
    readonly id: string;
    readonly calendarId: string | null;
    readonly title: string;
    readonly due: string | null;
    readonly allDay: boolean;
    readonly done: boolean;
    /** "ENG-42" for a Tasks task. */
    readonly reference: string | null;
    readonly listName: string | null;
    readonly editable: boolean;
}

/** The window the calendar is drawing, as one answer. */
export interface RangeView {
    readonly from: string;
    readonly to: string;
    readonly occurrences: readonly OccurrenceView[];
    readonly tasks: readonly TaskItemView[];
    /** Objects whose rule could not be expanded, named so the screen can say so. */
    readonly unreadable: number;
}

/** One invitation as the organizer tracks it. */
export interface InvitationView {
    readonly email: string;
    readonly partstat: PartStat;
    readonly sentAt: string | null;
    readonly respondedAt: string | null;
    readonly internal: boolean;
}

/** An event opened in the editor. */
export interface EventDetail {
    readonly objectId: string;
    readonly calendarId: string;
    readonly recurrenceKey: string | null;
    /** The version the editor saw, sent back so a save over a newer one is
     *  refused rather than silently overwriting it. */
    readonly version: string;
    /** The occurrence as it is (override or series), and the series. */
    readonly event: CalendarEvent;
    readonly series: CalendarEvent | null;
    readonly writable: boolean;
    readonly isOrganizer: boolean;
    /** The reader's own addresses, to find themselves among the attendees. */
    readonly myEmails: readonly string[];
    readonly invitations: readonly InvitationView[];
    /** The provider refused the last local change; it is kept to re-apply. */
    readonly conflict: boolean;
    /** Waiting to be written to the provider. */
    readonly pending: boolean;
    readonly busyOnly: boolean;
}

/** A task opened in the editor (a VTODO from a calendar). */
export interface TodoDetail {
    readonly objectId: string;
    readonly calendarId: string;
    readonly version: string;
    readonly todo: CalendarTodo;
    readonly writable: boolean;
}

/** Somebody a calendar is shared with. */
export interface ShareView {
    readonly id: string;
    readonly target:
        | { readonly kind: "user"; readonly id: string; readonly name: string }
        | { readonly kind: "team"; readonly id: string; readonly name: string };
    readonly access: "freebusy" | "read" | "write" | "manage";
}

/** One linked outside source and its calendars. */
export interface SourceView {
    readonly id: string;
    readonly kind: SourceKind;
    readonly label: string;
    readonly url: string;
    readonly username: string;
    readonly status: "ok" | "auth" | "unreachable" | "error";
    readonly lastError: string | null;
    readonly lastSyncAt: string | null;
    readonly refreshMinutes: number;
    readonly calendarCount: number;
    /** For google/microsoft: the linked account it reads through. */
    readonly connectionId: string | null;
}

/** Something in the trash. */
export interface TrashItemView {
    readonly kind: "calendar" | "event";
    readonly id: string;
    readonly title: string;
    readonly calendarName: string;
    readonly color: string;
    readonly deletedAt: string;
    /** When it is removed for good. */
    readonly purgeAt: string;
}

/** A search hit: one object, with its next (or last) occurrence. */
export interface SearchHit {
    readonly objectId: string;
    readonly calendarId: string;
    readonly summary: string;
    readonly location: string;
    readonly start: string | null;
    readonly allDay: boolean;
    readonly recurring: boolean;
    readonly color: string;
}

export type { Alarm, Attendee, Person };
