/**
 * The calendar's own words for what iCalendar (RFC 5545) describes.
 *
 * Every screen and every service speaks these; only `ical.ts` speaks iCalendar
 * text. The text stays the source of truth - a property this model has no field
 * for is kept verbatim in `extra` and written back unchanged, so a round trip
 * through Polaris never loses what Google, iCloud or Nextcloud put there.
 *
 * Pure types: shared by the server and the browser.
 */

/** A date with no time: an all-day value, `YYYY-MM-DD`. */
export interface DateOnly {
    readonly date: string;
}

/**
 * A date and time as written in the file.
 *
 * `dateTime` is the wall time (`YYYY-MM-DDTHH:mm:ss`), never an instant. `tzid`
 * is the IANA zone it is read in, `"UTC"` for a value written with `Z`, and null
 * for a floating time (read in whoever's zone is looking).
 */
export interface DateTimeValue {
    readonly dateTime: string;
    readonly tzid: string | null;
}

export type DateValue = DateOnly | DateTimeValue;

/** A wall-clock reading, the shape time-zone math works in. Months are 1-12. */
export interface WallTime {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
}

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export type Frequency =
    | "SECONDLY"
    | "MINUTELY"
    | "HOURLY"
    | "DAILY"
    | "WEEKLY"
    | "MONTHLY"
    | "YEARLY";

/**
 * A recurrence rule, as structured as the editor needs it.
 *
 * `supported` is false for a rule the editor cannot show faithfully (sub-daily
 * frequencies, BYWEEKNO, BYYEARDAY, BYHOUR...). Such a rule is kept as `raw`,
 * drawn as its summary and never rewritten unless the person replaces it.
 */
export interface RecurrenceRule {
    readonly frequency: Frequency;
    readonly interval: number;
    /** BYDAY entries: a weekday with an optional ordinal (1..5, -1, -2). */
    readonly byDay: readonly { readonly day: Weekday; readonly ordinal: number | null }[];
    readonly byMonthDay: readonly number[];
    readonly byMonth: readonly number[];
    readonly bySetPos: readonly number[];
    readonly count: number | null;
    /** UNTIL, as written. */
    readonly until: DateValue | null;
    readonly weekStart: Weekday | null;
    readonly supported: boolean;
    /** The rule as it appears after `RRULE:`. */
    readonly raw: string;
}

export type PartStat = "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" | "DELEGATED";

export type AttendeeRole = "CHAIR" | "REQ-PARTICIPANT" | "OPT-PARTICIPANT" | "NON-PARTICIPANT";

/** INDIVIDUAL people, GROUP lists, ROOM and RESOURCE bookables. */
export type CalendarUserType = "INDIVIDUAL" | "GROUP" | "RESOURCE" | "ROOM" | "UNKNOWN";

export interface Person {
    /** The address without `mailto:`, lowercased. */
    readonly email: string;
    readonly name: string;
    /**
     * Parameters of the ORGANIZER/ATTENDEE line this model has no field for
     * (SENT-BY, DELEGATED-FROM, X-NUM-GUESTS...), by lowercase name, written
     * back unchanged. Added by the engine for lossless round trips.
     */
    readonly params?: Readonly<Record<string, string | readonly string[]>>;
}

export interface Attendee extends Person {
    readonly role: AttendeeRole;
    readonly partstat: PartStat;
    readonly rsvp: boolean;
    readonly type: CalendarUserType;
}

export type AlarmAction = "DISPLAY" | "EMAIL" | "AUDIO";

/**
 * A reminder.
 *
 * Relative triggers are minutes from the start (negative = before) or from the
 * end when `related` is END. An absolute trigger is an instant.
 */
export type AlarmTrigger =
    | { readonly kind: "relative"; readonly minutes: number; readonly related: "START" | "END" }
    | { readonly kind: "absolute"; readonly at: string };

export interface Alarm {
    readonly action: AlarmAction;
    readonly trigger: AlarmTrigger;
    readonly description: string;
    /** The VALARM's other lines (REPEAT, ATTENDEE, X-WR-ALARMUID...), kept as
     *  written. Added by the engine for lossless round trips. */
    readonly extra?: readonly ExtraProperty[];
}

export interface Attachment {
    readonly uri: string;
    readonly name: string;
    readonly mime: string;
    /** The ATTACH line's other parameters (SIZE, MANAGED-ID...), by lowercase
     *  name. Added by the engine for lossless round trips. */
    readonly params?: Readonly<Record<string, string | readonly string[]>>;
}

export type EventStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";
export type Transparency = "OPAQUE" | "TRANSPARENT";
export type Classification = "PUBLIC" | "PRIVATE" | "CONFIDENTIAL";

/**
 * What kind of block an event is, beyond an ordinary one. Google's event types,
 * carried as `X-POLARIS-KIND` (and mapped to Google's own on sync).
 */
export type EventKind = "default" | "outOfOffice" | "focusTime" | "workingLocation";

/** A property this model does not read, kept to be written back unchanged. */
export interface ExtraProperty {
    /** The whole content line as it was, unfolded. */
    readonly line: string;
}

/** One VEVENT: a series master, a single event, or one overridden occurrence. */
export interface CalendarEvent {
    readonly uid: string;
    /** Set on an override: the original start of the occurrence it replaces. */
    readonly recurrenceId: DateValue | null;
    readonly thisAndFuture: boolean;
    readonly summary: string;
    readonly description: string;
    readonly location: string;
    readonly start: DateValue;
    /** DTEND, or the start plus DURATION when the file used one. */
    readonly end: DateValue;
    readonly status: EventStatus | null;
    readonly transparency: Transparency;
    readonly classification: Classification;
    readonly categories: readonly string[];
    /** A CSS colour (RFC 7986 COLOR), or null for the calendar's. */
    readonly color: string | null;
    readonly url: string;
    readonly organizer: Person | null;
    readonly attendees: readonly Attendee[];
    readonly alarms: readonly Alarm[];
    readonly rule: RecurrenceRule | null;
    readonly exdates: readonly DateValue[];
    readonly rdates: readonly DateValue[];
    readonly sequence: number;
    readonly attachments: readonly Attachment[];
    /** A meeting link (RFC 7986 CONFERENCE, or X-GOOGLE-CONFERENCE). */
    readonly conference: string;
    readonly kind: EventKind;
    readonly created: string | null;
    readonly lastModified: string | null;
    readonly extra: readonly ExtraProperty[];
    /**
     * Nested components this model does not read (a VALARM with ACTION:NONE,
     * RFC 9073 VLOCATION...), each the whole block as written, unfolded, lines
     * joined with CRLF. Added by the engine for lossless round trips.
     */
    readonly extraComponents?: readonly string[];
}

export type TodoStatus = "NEEDS-ACTION" | "IN-PROCESS" | "COMPLETED" | "CANCELLED";

/** One VTODO. */
export interface CalendarTodo {
    readonly uid: string;
    readonly summary: string;
    readonly description: string;
    readonly start: DateValue | null;
    readonly due: DateValue | null;
    readonly completed: string | null;
    readonly status: TodoStatus;
    readonly percent: number;
    /** 0 = undefined, 1 highest .. 9 lowest (RFC 5545). */
    readonly priority: number;
    readonly categories: readonly string[];
    readonly alarms: readonly Alarm[];
    readonly rule: RecurrenceRule | null;
    readonly extra: readonly ExtraProperty[];
    /** As on CalendarEvent. Added by the engine for lossless round trips. */
    readonly extraComponents?: readonly string[];
}

/**
 * One calendar object resource as it is stored: every component sharing a UID -
 * the master and its overrides - or one task. `timezones` keeps the VTIMEZONE
 * blocks verbatim for the round trip.
 */
export type CalendarItem =
    | {
          readonly component: "VEVENT";
          readonly uid: string;
          readonly master: CalendarEvent | null;
          readonly overrides: readonly CalendarEvent[];
          readonly timezones: readonly string[];
          readonly method: string | null;
      }
    | {
          readonly component: "VTODO";
          readonly uid: string;
          readonly todo: CalendarTodo;
          readonly timezones: readonly string[];
          readonly method: string | null;
      };

/** One drawn occurrence of an event, in instants. */
export interface Occurrence {
    readonly uid: string;
    /** The occurrence's original start, the key an edit of one occurrence uses:
     *  ISO instant for timed events, `YYYY-MM-DD` for all-day ones. */
    readonly recurrenceKey: string;
    readonly start: Date;
    readonly end: Date;
    readonly allDay: boolean;
    /** For all-day occurrences: the dates it covers, end exclusive. */
    readonly startDate: string | null;
    readonly endDate: string | null;
    /** Whether this occurrence is an override rather than generated. */
    readonly overridden: boolean;
    readonly recurring: boolean;
    readonly event: CalendarEvent;
}

/** A busy interval, in instants. */
export interface BusyInterval {
    readonly start: Date;
    readonly end: Date;
    /** BUSY, BUSY-TENTATIVE, BUSY-UNAVAILABLE (out of office). */
    readonly type: "BUSY" | "BUSY-TENTATIVE" | "BUSY-UNAVAILABLE";
}

/** Which occurrences an edit or a delete of a recurring event reaches. */
export type EditScope = "this" | "following" | "all";
