"use server";

/**
 * The floor and its orders. Taking orders needs `hospitality.use`; changing a
 * room's plan needs `hospitality.manage`. Every input is validated first.
 */

import { z } from "zod";
import { ownVenue } from "../lib/audit";
import * as orders from "../lib/orders";
import * as load from "../lib/service-load";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { addLinesInput, coversInput, floorInput, lineOnly, moveInput, openOrderInput, sendInput, splitInput, venueOnly } from "../model/order-schemas";

export async function readServiceAction(raw: unknown): Promise<Outcome<{ service: orders.ServiceView }>> {
    const input = venueOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (ownVenue(user, input.data.venueId), { service: await orders.readService(input.data.venueId) }));
}

const screenQuery = z.object({ venueId: z.string().uuid().nullable() });

/** The Service screen's whole first load (menu, floor, open orders) in one request. */
export async function readServiceScreenAction(raw: unknown): Promise<Outcome<load.ServiceScreenView>> {
    const input = screenQuery.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => {
        // A linked device only ever sees its own venue, whatever it asks for.
        const venueId = user.device ? (input.data.venueId ?? user.venueId ?? null) : input.data.venueId;
        if (user.device) ownVenue(user, venueId);
        return load.readServiceScreen(venueId);
    });
}

export async function setCoversAction(raw: unknown): Promise<Outcome<object>> {
    const input = coversInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => (await orders.setCovers(input.data.orderId, input.data.covers, user), {}));
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
