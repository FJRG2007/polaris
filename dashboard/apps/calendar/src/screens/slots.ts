/**
 * Where the screens that are built elsewhere plug into the calendar.
 *
 * Sharing, publishing, linked accounts and subscriptions, booking pages,
 * meeting proposals, "find a time" and the room picker have their own
 * components. The calendar draws each of them only when it is set here - an
 * entry that is not set draws no menu item and no button, so nothing on the
 * screen leads nowhere.
 */

import type { ComponentType } from "react";
import type { CalendarSummary } from "../lib/wire";
import { RoomPicker } from "./rooms/room-picker";
import { FindATime } from "./freebusy/find-a-time";
import { ProposalsSection } from "./proposals/proposals-view";
import { BookingPagesSection } from "./booking/booking-section";
import { AddCalendarsDialog } from "./accounts/add-calendars-dialog";
import { PublishCalendarDialog, ShareCalendarDialog } from "./sharing/share-dialog";

/** A dialog about one calendar: sharing it, publishing it. */
export interface CalendarDialogSlotProps {
    readonly calendar: CalendarSummary;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** Something changed: the calendar list is read again. */
    readonly onChanged: () => void;
}

/** A dialog that adds calendars: a subscription, a linked account, holidays. */
export interface AddCalendarsSlotProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onChanged: () => void;
}

/** "Find a time" for the people on an event. */
export interface FindATimeSlotProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** Addresses of the attendees, the organizer's included. */
    readonly attendees: readonly string[];
    /** The event's current start and end, as instants (ISO). */
    readonly start: string;
    readonly end: string;
    /** The zone the reader sees times in. */
    readonly zone: string;
    /** A time was chosen: the editor moves the event to it. */
    readonly onPick: (start: string, end: string) => void;
}

/** Choosing a room or a piece of equipment for an event. */
export interface RoomPickerSlotProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly start: string;
    readonly end: string;
    readonly zone: string;
    /** A room was chosen: invited as an attendee of type ROOM or RESOURCE. */
    readonly onPick: (room: {
        readonly email: string;
        readonly name: string;
        readonly type: "ROOM" | "RESOURCE";
    }) => void;
}

/** A section of the sidebar: booking pages, meeting proposals. */
export interface SidebarSectionSlotProps {
    /** The reader's display zone. */
    readonly zone: string;
}

export interface CalendarSlots {
    readonly ShareCalendar?: ComponentType<CalendarDialogSlotProps>;
    readonly PublishCalendar?: ComponentType<CalendarDialogSlotProps>;
    readonly AddCalendars?: ComponentType<AddCalendarsSlotProps>;
    readonly FindATime?: ComponentType<FindATimeSlotProps>;
    readonly RoomPicker?: ComponentType<RoomPickerSlotProps>;
    readonly BookingPagesSection?: ComponentType<SidebarSectionSlotProps>;
    readonly ProposalsSection?: ComponentType<SidebarSectionSlotProps>;
}

export const calendarSlots: CalendarSlots = {
    ShareCalendar: ShareCalendarDialog,
    PublishCalendar: PublishCalendarDialog,
    AddCalendars: AddCalendarsDialog,
    FindATime,
    RoomPicker,
    BookingPagesSection,
    ProposalsSection
};
