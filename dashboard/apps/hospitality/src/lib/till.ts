/**
 * The kitchen display, discounts, payments and the till. Every function is
 * called by an action that has already checked the permission and validated
 * its input.
 *
 * A payment's id is made by the device, so paying twice from a retry stores
 * one payment. An order is closed when what was paid reaches its total, which
 * is computed here, never sent by the device. A closed order gets the next
 * simplified invoice number of its venue and year from a counter row that is
 * incremented inside the same transaction, so the series has no gaps and no
 * repeats however many tills close at once.
 *
 * Server-only.
 */

import { Prisma, prisma } from "@polaris/db";
import { readDiscount } from "./orders";
import { HospitalityRefusal } from "./outcome";
import * as events from "./events";
import { publishHospitalityChange } from "./live";
import { lineTotal, orderTotals, type Discount } from "../model/pricing";
import { shiftReport, type ShiftReport } from "../model/cash";
import type { CashMoveInput, DiscountInput, PayInput } from "../model/till-schemas";

export interface KitchenTicket {
    readonly orderId: string;
    readonly table: string;
    readonly waiterName: string;
    readonly lines: ReadonlyArray<{
        id: string;
        name: string;
        quantity: number;
        note: string;
        course: number;
        modifiers: string[];
        status: string;
        sentAt: string;
    }>;
}

/** What a station has to make: lines sent and not yet ready, oldest first, per order. */
export async function readKitchen(venueId: string, station: string | null): Promise<KitchenTicket[]> {
    const lines = await prisma.hospitalityOrderLine.findMany({
        where: {
            status: "sent",
            ...(station ? { station } : {}),
            order: { venueId, status: { in: ["open", "billed"] } }
        },
        orderBy: { sentAt: "asc" },
        include: { order: { select: { id: true, tableId: true, label: true, waiterName: true } } },
        take: 500
    });
    const tableIds = [...new Set(lines.flatMap((l) => (l.order.tableId ? [l.order.tableId] : [])))];
    const tables = await prisma.hospitalityTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, name: true } });
    const tableName = new Map(tables.map((x) => [x.id, x.name]));
    const tickets = new Map<string, KitchenTicket>();
    for (const line of lines) {
        const ticket = tickets.get(line.orderId) ?? {
            orderId: line.orderId,
            table: (line.order.tableId && tableName.get(line.order.tableId)) || line.order.label,
            waiterName: line.order.waiterName,
            lines: []
        };
        const modifiers = Array.isArray(line.modifiers)
            ? (line.modifiers as Array<{ name?: unknown }>).flatMap((m) => (typeof m?.name === "string" ? [m.name] : []))
            : [];
        (ticket.lines as KitchenTicket["lines"][number][]).push({
            id: line.id,
            name: line.name,
            quantity: line.quantity,
            note: line.note,
            course: line.course,
            modifiers,
            status: line.status,
            sentAt: (line.sentAt ?? line.createdAt).toISOString()
        });
        tickets.set(line.orderId, ticket);
    }
    return [...tickets.values()];
}

/** Bump (ready) or recall (back to sent) lines on the kitchen display. */
interface MovingLine {
    readonly orderId: string;
    readonly order: { readonly venueId: string; readonly label: string; readonly waiterId: string | null; readonly tableId: string | null };
}

/** One "table waiting" per order whose lines just went ready, named by its table or its label. */
async function tellTablesWaiting(lines: readonly MovingLine[], actorId: string, at: Date): Promise<void> {
    const byOrder = new Map<string, { order: MovingLine["order"]; count: number }>();
    for (const line of lines) {
        const entry = byOrder.get(line.orderId) ?? { order: line.order, count: 0 };
        entry.count += 1;
        byOrder.set(line.orderId, entry);
    }
    if (byOrder.size === 0) return;
    const tableIds = [...new Set([...byOrder.values()].flatMap(({ order }) => (order.tableId ? [order.tableId] : [])))];
    const tables = tableIds.length
        ? await prisma.hospitalityTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, name: true } }).catch(() => [])
        : [];
    const names = new Map(tables.map((table) => [table.id, table.name]));
    for (const [id, { order, count }] of byOrder) {
        const name = (order.tableId && names.get(order.tableId)) || order.label;
        events.tableWaiting({ id, venueId: order.venueId, name, waiterId: order.waiterId }, count, actorId, at);
    }
}

export async function markLines(lineIds: readonly string[], ready: boolean, actorId: string): Promise<void> {
    const readyAt = new Date();
    // Only the lines this press moves: one already ready, pressed again, tells nobody.
    const moving = await prisma.hospitalityOrderLine.findMany({
        where: { id: { in: [...lineIds] }, status: ready ? "sent" : "ready" },
        select: { orderId: true, order: { select: { venueId: true, label: true, waiterId: true, tableId: true } } },
        take: 500
    });
    await prisma.hospitalityOrderLine.updateMany({
        where: { id: { in: [...lineIds] }, status: ready ? "sent" : "ready" },
        data: ready ? { status: "ready", readyAt } : { status: "sent", readyAt: null }
    });
    const venueId = moving[0]?.order.venueId ?? null;
    publishHospitalityChange({ venueId, actorId, topic: "kitchen" });
    if (ready) await tellTablesWaiting(moving, actorId, readyAt);
}

/** A discount on the whole order or on one line; `discount: null` removes it. */
export async function setDiscount(input: DiscountInput, actorId: string): Promise<void> {
    const order = await prisma.hospitalityOrder.findUnique({ where: { id: input.orderId }, select: { venueId: true, status: true } });
    if (!order) throw new HospitalityRefusal("orders.gone");
    if (order.status === "paid" || order.status === "void") throw new HospitalityRefusal("orders.closed");
    const value: Discount | null = input.discount;
    const discount = value ? ({ ...value } as Prisma.InputJsonValue) : Prisma.DbNull;
    if (input.lineId) {
        await prisma.hospitalityOrderLine.updateMany({ where: { id: input.lineId, orderId: input.orderId }, data: { discount } });
    } else {
        await prisma.hospitalityOrder.update({ where: { id: input.orderId }, data: { discount } });
    }
    publishHospitalityChange({ venueId: order.venueId, actorId, topic: "orders" });
}

/** The shift open at a venue, or null. */
export async function openShift(venueId: string) {
    return prisma.hospitalityShift.findFirst({ where: { venueId, closedAt: null }, orderBy: { openedAt: "desc" } });
}

async function nextNumber(tx: Prisma.TransactionClient, key: string): Promise<number> {
    const row = await tx.hospitalityCounter.upsert({
        where: { key },
        create: { key, value: 1 },
        update: { value: { increment: 1 } }
    });
    return row.value;
}

/**
 * Takes payments on an order. When the order is fully paid it is closed with
 * its total stored and its simplified invoice number given. Change is the
 * device's to show: it is `tendered - amount` of a cash payment.
 */
export async function pay(input: PayInput, actor: { id: string; name: string }): Promise<{ closed: boolean; ticketNo: string | null; due: number }> {
    const order = await prisma.hospitalityOrder.findUnique({
        where: { id: input.orderId },
        include: { lines: true, payments: true }
    });
    if (!order) throw new HospitalityRefusal("orders.gone");
    if (order.status === "void") throw new HospitalityRefusal("orders.closed");
    const shift = await openShift(order.venueId);
    if (!shift) throw new HospitalityRefusal("till.noShift");
    const totals = orderTotals(
        order.lines.map((l) => ({ ...l, modifiers: Array.isArray(l.modifiers) ? (l.modifiers as never) : [], discount: readDiscount(l.discount) })),
        readDiscount(order.discount)
    );
    const known = new Set(order.payments.map((p) => p.id));
    const fresh = input.payments.filter((p) => !known.has(p.id));
    const paidBefore = order.payments.reduce((s, p) => s + p.amount, 0);
    const paidNow = fresh.reduce((s, p) => s + p.amount, 0);
    if (order.status === "paid" || fresh.length === 0) {
        return { closed: order.status === "paid", ticketNo: order.ticketNo, due: Math.max(0, totals.total - paidBefore) };
    }
    if (paidBefore + paidNow > totals.total) throw new HospitalityRefusal("till.overpaid");
    const closes = paidBefore + paidNow === totals.total;
    const venue = await prisma.hospitalityVenue.findUnique({ where: { id: order.venueId }, select: { ticketPrefix: true } });
    const year = new Date().getFullYear();
    const ticketNo = await prisma.$transaction(async (tx) => {
        await tx.hospitalityPayment.createMany({
            data: fresh.map((p) => ({
                id: p.id,
                orderId: order.id,
                shiftId: shift.id,
                method: p.method,
                amount: p.amount,
                tip: p.tip,
                tendered: p.tendered,
                lineIds: p.lineIds,
                byId: actor.id,
                byName: actor.name
            })),
            skipDuplicates: true
        });
        if (!closes) return null;
        const n = await nextNumber(tx, `${order.venueId}:ticket:${year}`);
        const number = `${venue?.ticketPrefix ?? "T"}${year}-${String(n).padStart(6, "0")}`;
        await tx.hospitalityOrder.update({
            where: { id: order.id },
            data: { status: "paid", ticketNo: number, total: totals.total, shiftId: shift.id, closedAt: new Date() }
        });
        return number;
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "cash" });
    const due = Math.max(0, totals.total - paidBefore - paidNow);
    events.billPaid(order.id, order.venueId, due, closes, fresh.map((p) => p.id));
    return { closed: closes, ticketNo, due };
}

/** The bill asked for: the table shows it, nothing else changes. */
export async function markBilled(orderId: string, actorId: string): Promise<void> {
    const order = await prisma.hospitalityOrder.update({ where: { id: orderId }, data: { status: "billed" }, select: { venueId: true } });
    publishHospitalityChange({ venueId: order.venueId, actorId, topic: "orders" });
}

export async function startShift(venueId: string, float: number, actor: { id: string; name: string }) {
    if (await openShift(venueId)) throw new HospitalityRefusal("till.shiftOpen");
    const shift = await prisma.hospitalityShift.create({
        data: { venueId, float, openedById: actor.id, openedByName: actor.name },
        select: { id: true }
    });
    publishHospitalityChange({ venueId, actorId: actor.id, topic: "cash" });
    return shift.id;
}

export async function moveCash(input: CashMoveInput, actor: { id: string; name: string }): Promise<void> {
    const shift = await openShift(input.venueId);
    if (!shift) throw new HospitalityRefusal("till.noShift");
    await prisma.hospitalityCashMove.createMany({
        data: [{ id: input.id, shiftId: shift.id, kind: input.kind, amount: input.amount, reason: input.reason, byId: actor.id, byName: actor.name }],
        skipDuplicates: true
    });
    publishHospitalityChange({ venueId: input.venueId, actorId: actor.id, topic: "cash" });
}

async function reportOf(shift: { id: string; float: number }): Promise<ShiftReport> {
    const [orders, payments, moves] = await Promise.all([
        prisma.hospitalityOrder.findMany({ where: { shiftId: shift.id }, include: { lines: true }, take: 10_000 }),
        prisma.hospitalityPayment.findMany({ where: { shiftId: shift.id }, select: { method: true, amount: true, tip: true } }),
        prisma.hospitalityCashMove.findMany({ where: { shiftId: shift.id }, select: { kind: true, amount: true } })
    ]);
    return shiftReport({
        float: shift.float,
        payments,
        moves,
        orders: orders.map((o) => {
            const lines = o.lines.map((l) => ({ ...l, modifiers: Array.isArray(l.modifiers) ? (l.modifiers as never) : [], discount: readDiscount(l.discount) }));
            const totals = orderTotals(lines, readDiscount(o.discount));
            return {
                status: o.status,
                total: o.total,
                covers: o.covers,
                discounts: totals.discounts,
                lines: lines.filter((l) => l.status !== "void").map((l) => ({ name: l.name, quantity: l.quantity, total: lineTotal(l), taxRateBp: l.taxRateBp }))
            };
        })
    });
}

/** The X report: the open shift so far. Closes nothing. */
export async function xReport(venueId: string) {
    const shift = await openShift(venueId);
    if (!shift) return null;
    return { shift: { id: shift.id, openedAt: shift.openedAt.toISOString(), openedByName: shift.openedByName, float: shift.float }, report: await reportOf(shift) };
}

/**
 * The Z report: closes the shift with what was counted (counted blind - the
 * screen never shows the expected figure before the count is entered) and
 * gives it the venue's next Z number. Orders still open stay open and are
 * taken by the next shift: that is the handover.
 */
export async function closeShift(venueId: string, counted: number, actor: { id: string; name: string }) {
    const shift = await openShift(venueId);
    if (!shift) throw new HospitalityRefusal("till.noShift");
    const report = await reportOf(shift);
    const expected = report.expected;
    const zNumber = await prisma.$transaction(async (tx) => {
        const n = await nextNumber(tx, `${venueId}:z`);
        await tx.hospitalityShift.update({
            where: { id: shift.id },
            data: { closedAt: new Date(), closedById: actor.id, closedByName: actor.name, counted, expected, zNumber: n }
        });
        return n;
    });
    publishHospitalityChange({ venueId, actorId: actor.id, topic: "cash" });
    events.shiftClosed(shift.id, venueId, zNumber, counted, expected);
    return { zNumber, counted, expected, difference: counted - expected, report };
}
