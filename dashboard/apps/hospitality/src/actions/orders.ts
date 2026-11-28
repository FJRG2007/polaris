"use server";

/**
 * The floor and its orders. Taking orders needs `hospitality.use`; changing a
 * room's plan needs `hospitality.manage`. Every input is validated first.
 */

import { ownVenue } from "../lib/audit";
import * as orders from "../lib/orders";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { addLinesInput, floorInput, lineOnly, moveInput, openOrderInput, sendInput, splitInput, venueOnly } from "../model/order-schemas";

export async function readServiceAction(raw: unknown): Promise<Outcome<{ service: orders.ServiceView }>> {
    const input = venueOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (ownVenue(user, input.data.venueId), { service: await orders.readService(input.data.venueId) }));
}

export async function openOrderAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = openOrderInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => ({ id: await orders.openOrder(input.data, user) }));
}

export async function addLinesAction(raw: unknown): Promise<Outcome<object>> {
    const input = addLinesInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await orders.addLines(input.data, user), {}));
}

export async function sendLinesAction(raw: unknown): Promise<Outcome<{ sent: number }>> {
    const input = sendInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => ({
        sent: await orders.sendLines(input.data.orderId, input.data.course, user)
    }));
}

export async function removeLineAction(raw: unknown): Promise<Outcome<object>> {
    const input = lineOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await orders.removeLine(input.data.lineId, user, input.data.version), {}));
}

/** Undo of a removed line, put back from the audit trail. */
export async function restoreLineAction(raw: unknown): Promise<Outcome<object>> {
    const input = lineOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await orders.restoreLine(input.data.lineId, user), {}));
}

export async function moveOrderAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = moveInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => ({
        id: await orders.moveOrder(input.data.orderId, input.data.tableId, user, input.data.version)
    }));
}

export async function splitOrderAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = splitInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => ({ id: await orders.splitOrder(input.data, user) }));
}

export async function saveFloorAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = floorInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ id: await orders.saveFloor(input.data, user.id) }));
}
