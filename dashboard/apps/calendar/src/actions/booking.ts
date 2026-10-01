"use server";

/**
 * Booking pages: the owner's list and editor, and what a visitor does on a
 * public page - hold a slot, confirm it from their email, cancel or move it.
 * The visitor's actions ask for no session; the token in their link is the
 * whole of their right, and every one of them is rate limited.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as booking from "../lib/booking";
import * as schemas from "../lib/schemas";
import { requireCalendarUser } from "../lib/access";
import { outcome, type Outcome } from "../lib/outcome";
import { refusedInput } from "../lib/scheduling-guard";
import * as scheduling from "../lib/scheduling-schemas";
import type { BookingPageView, BookingView } from "../lib/scheduling-wire";

/** The address every link Polaris hands out is built on - the configured
 *  domain, never the tab's host. */
export async function linkBaseAction(): Promise<Outcome<{ base: string }>> {
    return outcome(async () => {
        await requireCalendarUser();
        return { base: await host.domainService.appBaseUrl() };
    });
}

export async function listBookingPagesAction(): Promise<Outcome<{ pages: BookingPageView[] }>> {
    return outcome(async () => ({
        pages: await booking.listBookingPages(await requireCalendarUser())
    }));
}

export async function bookingPageAction(id: unknown): Promise<Outcome<{ page: BookingPageView }>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        page: await booking.bookingPage(await requireCalendarUser(), parsed.data)
    }));
}

export async function createBookingPageAction(
    input: unknown
): Promise<Outcome<{ page: BookingPageView }>> {
    const parsed = scheduling.bookingPageInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        page: await booking.createBookingPage(await requireCalendarUser(), parsed.data)
    }));
}

export async function updateBookingPageAction(
    id: unknown,
    input: unknown
): Promise<Outcome<{ page: BookingPageView }>> {
    const parsedId = schemas.uuidSchema.safeParse(id);
    if (!parsedId.success) return refusedInput(parsedId.error.issues);
    const parsed = scheduling.bookingPageInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        page: await booking.updateBookingPage(
            await requireCalendarUser(),
            parsedId.data,
            parsed.data
        )
    }));
}

export async function duplicateBookingPageAction(
    id: unknown
): Promise<Outcome<{ page: BookingPageView }>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        page: await booking.duplicateBookingPage(await requireCalendarUser(), parsed.data)
    }));
}

export async function deleteBookingPageAction(id: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await booking.deleteBookingPage(await requireCalendarUser(), parsed.data);
        return {};
    });
}

export async function listBookingsAction(
    pageId: unknown
): Promise<Outcome<{ bookings: BookingView[] }>> {
    const parsed = schemas.uuidSchema.safeParse(pageId);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        bookings: await booking.listBookings(await requireCalendarUser(), parsed.data)
    }));
}

export async function cancelBookingAsOwnerAction(bookingId: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(bookingId);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await booking.cancelBookingAsOwner(await requireCalendarUser(), parsed.data);
        return {};
    });
}

// ---------------------------------------------------------------- the visitor

export async function requestBookingAction(input: unknown): Promise<Outcome<{ email: string }>> {
    const parsed = scheduling.bookingRequestSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(() => booking.requestBooking(parsed.data));
}

export async function confirmBookingAction(
    token: unknown
): Promise<
    Outcome<{ status: "confirmed" | "taken" | "expired" | "cancelled"; manageToken: string | null }>
> {
    const parsed = scheduling.tokenSchema.safeParse(token);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(() => booking.confirmBooking(parsed.data));
}

export async function cancelBookingAction(token: unknown): Promise<Outcome<object>> {
    const parsed = scheduling.tokenSchema.safeParse(token);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await booking.cancelBooking(parsed.data);
        return {};
    });
}

const rescheduleInput = z.object({
    token: scheduling.tokenSchema,
    start: z.string().datetime({ offset: true })
});

export async function rescheduleBookingAction(
    input: unknown
): Promise<Outcome<{ start: string; end: string }>> {
    const parsed = rescheduleInput.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(() => booking.rescheduleBooking(parsed.data.token, parsed.data.start));
}
