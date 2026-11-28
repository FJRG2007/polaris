"use server";

/**
 * The kitchen display, the bill, payments and the till. A waiter
 * (`hospitality.use`) sees the kitchen, asks for the bill and takes payment;
 * discounts, opening and closing the till and moving cash need
 * `hospitality.manage`. Every input is validated first.
 */

import * as till from "../lib/till";
import { resolveVenue } from "../lib/catalog";
import { readOpenChecks, type OpenCheck } from "../lib/service-load";
import { ownVenue } from "../lib/audit";
import { venueOnly } from "../model/order-schemas";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { cashMoveInput, discountInput, kitchenInput, kitchenScreenInput, markInput, orderOnly, payInput, shiftCloseInput, shiftOpenInput, tillScreenInput } from "../model/till-schemas";

export async function readKitchenAction(raw: unknown): Promise<Outcome<{ tickets: till.KitchenTicket[] }>> {
    const input = kitchenInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (ownVenue(user, input.data.venueId), { tickets: await till.readKitchen(input.data.venueId, input.data.station) }));
}

/** The kitchen screen's load in one request: which venue, and its tickets. */
export async function readKitchenScreenAction(raw: unknown): Promise<Outcome<{ venueId: string | null; tickets: till.KitchenTicket[] }>> {
    const input = kitchenScreenInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => {
        const venue = await resolveVenue(user.device ? (user.venueId ?? null) : input.data.venueId);
        if (!venue) return { venueId: null, tickets: [] };
        ownVenue(user, venue.id);
        return { venueId: venue.id, tickets: await till.readKitchen(venue.id, input.data.station) };
    });
}

export async function markLinesAction(raw: unknown): Promise<Outcome<object>> {
    const input = markInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await till.markLines(input.data.lineIds, input.data.ready, user), {}));
}

export async function setDiscountAction(raw: unknown): Promise<Outcome<object>> {
    const input = discountInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => (await till.setDiscount(input.data, user), {}));
}

export async function markBilledAction(raw: unknown): Promise<Outcome<object>> {
    const input = orderOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await till.markBilled(input.data.orderId, user), {}));
}

export async function payAction(raw: unknown): Promise<Outcome<{ closed: boolean; ticketNo: string | null; due: number }>> {
    const input = payInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", (user) => till.pay(input.data, user));
}

export async function readTillAction(raw: unknown): Promise<Outcome<{ till: Awaited<ReturnType<typeof till.xReport>> }>> {
    const input = venueOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async () => ({ till: await till.xReport(input.data.venueId) }));
}

/** The till screen's load in one request: which venue (and its currency), and its X report. */
export async function readTillScreenAction(raw: unknown): Promise<
    Outcome<{ venue: { id: string; currency: string } | null; till: Awaited<ReturnType<typeof till.xReport>> | null; checks: OpenCheck[] }>
> {
    const input = tillScreenInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async () => {
        const venue = await resolveVenue(input.data.venueId);
        if (!venue) return { venue, till: null, checks: [] };
        const [report, checks] = await Promise.all([till.xReport(venue.id), readOpenChecks(venue.id)]);
        return { venue, till: report, checks };
    });
}

export async function openShiftAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = shiftOpenInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ id: await till.startShift(input.data.venueId, input.data.float, user) }));
}

export async function moveCashAction(raw: unknown): Promise<Outcome<object>> {
    const input = cashMoveInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => (await till.moveCash(input.data, user), {}));
}

export async function closeShiftAction(
    raw: unknown
): Promise<Outcome<{ closed: Awaited<ReturnType<typeof till.closeShift>> }>> {
    const input = shiftCloseInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ closed: await till.closeShift(input.data.venueId, input.data.counted, user) }));
}
