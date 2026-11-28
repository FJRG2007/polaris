"use server";

/**
 * The floor and its orders. Taking orders needs `hospitality.use`; changing a
 * room's plan needs `hospitality.manage`. Every input is validated first.
 */

import * as orders from "../lib/orders";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { addLinesInput, floorInput, lineOnly, moveInput, openOrderInput, sendInput, venueOnly } from "../model/order-schemas";

export async function readServiceAction(raw: unknown): Promise<Outcome<{ service: orders.ServiceView }>> {
    const input = venueOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async () => ({ service: await orders.readService(input.data.venueId) }));
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
        sent: await orders.sendLines(input.data.orderId, input.data.course, user.id)
    }));
}

export async function removeLineAction(raw: unknown): Promise<Outcome<object>> {
    const input = lineOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await orders.removeLine(input.data.lineId, user.id), {}));
}

export async function moveOrderAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = moveInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => ({
        id: await orders.moveOrder(input.data.orderId, input.data.tableId, user.id)
    }));
}

export async function saveFloorAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = floorInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ id: await orders.saveFloor(input.data, user.id) }));
}
