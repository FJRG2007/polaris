"use server";

/**
 * The kitchen display, the bill, payments and the till. A waiter
 * (`hospitality.use`) sees the kitchen, asks for the bill and takes payment;
 * discounts, opening and closing the till and moving cash need
 * `hospitality.manage`. Every input is validated first.
 */

import * as till from "../lib/till";
import { venueOnly } from "../model/order-schemas";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { cashMoveInput, discountInput, kitchenInput, markInput, orderOnly, payInput, shiftCloseInput, shiftOpenInput } from "../model/till-schemas";

export async function readKitchenAction(raw: unknown): Promise<Outcome<{ tickets: till.KitchenTicket[] }>> {
    const input = kitchenInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async () => ({ tickets: await till.readKitchen(input.data.venueId, input.data.station) }));
}

export async function markLinesAction(raw: unknown): Promise<Outcome<object>> {
    const input = markInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await till.markLines(input.data.lineIds, input.data.ready, user.id), {}));
}

export async function setDiscountAction(raw: unknown): Promise<Outcome<object>> {
    const input = discountInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => (await till.setDiscount(input.data, user.id), {}));
}

export async function markBilledAction(raw: unknown): Promise<Outcome<object>> {
    const input = orderOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await till.markBilled(input.data.orderId, user.id), {}));
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
