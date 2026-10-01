/**
 * What the booking, proposal, room, free/busy and answer services hand their
 * screens: plain JSON shapes. Instants travel as ISO strings.
 *
 * Pure types.
 */

import type { ResourceInfo } from "./wire";
import type { PartStat } from "../engine/types";
import type { Availability } from "../engine/booking";
import type { BookingQuestion, Vote } from "./scheduling-schemas";

/** A booking page as its owner edits it. */
export interface BookingPageView {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly location: string;
    readonly visibility: "link" | "public";
    readonly calendarId: string;
    readonly conflictIds: readonly string[];
    readonly durationMinutes: number;
    readonly slotMinutes: number;
    readonly bufferBefore: number;
    readonly bufferAfter: number;
    readonly noticeMinutes: number;
    readonly maxPerDay: number | null;
    readonly horizonDays: number;
    readonly timezone: string;
    readonly availability: Availability;
    readonly questions: readonly BookingQuestion[];
    readonly meetingLink: boolean;
    readonly enabled: boolean;
    /** Confirmed bookings still ahead. */
    readonly upcoming: number;
}

/** One booking, as the page's owner sees it. */
export interface BookingView {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly start: string;
    readonly end: string;
    readonly status: "pending" | "confirmed" | "cancelled";
    readonly timezone: string;
    /** The questions' labels with the visitor's answers, in the page's order. */
    readonly answers: readonly { readonly label: string; readonly value: string }[];
    readonly objectId: string | null;
    readonly createdAt: string;
}

/** A booking page as a visitor sees it. Nothing about the owner's calendars. */
export interface PublicBookingPage {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly location: string;
    readonly durationMinutes: number;
    readonly timezone: string;
    readonly horizonDays: number;
    readonly questions: readonly BookingQuestion[];
    readonly ownerName: string;
}

/** One open slot. */
export interface SlotView {
    readonly start: string;
    readonly end: string;
}

/** A booking as its manage link shows it. */
export interface ManagedBooking {
    readonly state: "pending" | "expired" | "confirmed" | "cancelled" | "past";
    /** Which token opened it: the confirmation link or the manage link. */
    readonly via: "confirm" | "manage";
    readonly name: string;
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
    readonly page: PublicBookingPage;
}

/** A proposal in its owner's list. */
export interface ProposalSummary {
    readonly id: string;
    readonly title: string;
    readonly status: "open" | "closed";
    readonly dates: number;
    readonly participants: number;
    readonly answered: number;
    readonly updatedAt: string;
}

/** A proposal opened by its owner: every date, every participant, every vote. */
export interface ProposalView {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly location: string;
    readonly durationMinutes: number;
    readonly timezone: string;
    readonly notify: boolean;
    readonly status: "open" | "closed";
    readonly calendarId: string | null;
    readonly objectId: string | null;
    readonly dates: readonly { readonly id: string; readonly start: string }[];
    readonly participants: readonly {
        readonly id: string;
        readonly name: string;
        readonly email: string;
        readonly required: boolean;
        readonly internal: boolean;
        readonly respondedAt: string | null;
        readonly votes: Readonly<Record<string, Vote>>;
    }[];
}

/** A proposal as one participant's vote link shows it. */
export interface VotePageView {
    readonly title: string;
    readonly description: string;
    readonly location: string;
    readonly durationMinutes: number;
    readonly timezone: string;
    readonly status: "open" | "closed";
    readonly organizer: string;
    readonly participantName: string;
    readonly dates: readonly { readonly id: string; readonly start: string }[];
    readonly votes: Readonly<Record<string, Vote>>;
    /** When closed: the date chosen, if any. */
    readonly chosen: string | null;
}

/** A room or a piece of equipment. */
export interface RoomView {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly color: string;
    readonly email: string;
    readonly resource: ResourceInfo;
}

/** A room with whether it is free for the time asked about. */
export interface RoomAvailability extends RoomView {
    readonly free: boolean;
}

/** One person's answer in a free/busy question. */
export interface FreeBusyPerson {
    /** What was asked for: the address, or the account id. */
    readonly key: string;
    readonly name: string;
    /** `ok`: their busy time follows; `unavailable`: not somebody the reader may
     *  look up (or no Polaris account) - said the same way for both, so the
     *  answer never tells whether an account exists. */
    readonly status: "ok" | "unavailable";
    readonly busy: readonly {
        readonly start: string;
        readonly end: string;
        readonly type: "BUSY" | "BUSY-TENTATIVE" | "BUSY-UNAVAILABLE";
    }[];
    /** Outside their working hours inside the window. */
    readonly away: readonly { readonly start: string; readonly end: string }[];
}

export interface FreeBusyView {
    readonly from: string;
    readonly to: string;
    readonly people: readonly FreeBusyPerson[];
    /** Times everybody with an answer is free and at work, when a length was asked. */
    readonly suggestions: readonly { readonly start: string; readonly end: string }[];
}

/** An invitation as its answer link shows it. */
export interface RsvpView {
    readonly title: string;
    readonly description: string;
    readonly location: string;
    readonly conference: string;
    readonly organizer: string;
    readonly start: string;
    readonly end: string;
    readonly allDay: boolean;
    readonly startDate: string | null;
    readonly endDate: string | null;
    readonly timezone: string;
    readonly recurring: boolean;
    readonly cancelled: boolean;
    readonly email: string;
    readonly partstat: PartStat;
    /** The next occurrences of a series, for answering one of them. */
    readonly occurrences: readonly {
        readonly key: string;
        readonly start: string;
        readonly allDay: boolean;
    }[];
}
