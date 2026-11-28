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
import { audit, ownVenue, touchOrder, type Actor } from "./audit";
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
export async function markLines(lineIds: readonly string[], ready: boolean, actor: Actor): Promise<void> {
    const lines = await prisma.hospitalityOrderLine.findMany({
        where: { id: { in: [...lineIds] } },
        select: { orderId: true, order: { select: { venueId: true } } }
    });
    const venueId = lines[0]?.order.venueId ?? null;
    for (const line of lines) ownVenue(actor, line.order.venueId);
    await prisma.$transaction(async (tx) => {
        const done = await tx.hospitalityOrderLine.updateMany({
            where: { id: { in: [...lineIds] }, status: ready ? "sent" : "ready" },
            data: ready ? { status: "ready", readyAt: new Date() } : { status: "sent", readyAt: null }
        });
        if (done.count > 0 && venueId) {
            await audit(tx, actor, { venueId, orderId: lines[0]?.orderId ?? null, kind: "kitchen.mark", payload: { lineIds, ready } });
        }
    });
    publishHospitalityChange({ venueId, actorId: actor.id, topic: "kitchen" });
}

/** A discount on the whole order or on one line; `discount: null` removes it. */
export async function setDiscount(input: DiscountInput, actor: Actor): Promise<void> {
    const order = await prisma.hospitalityOrder.findUnique({ where: { id: input.orderId }, select: { venueId: true, status: true } });
    if (!order) throw new HospitalityRefusal("orders.gone");
    if (order.status === "paid" || order.status === "void") throw new HospitalityRefusal("orders.closed");
    const value: Discount | null = input.discount;
    const discount = value ? ({ ...value } as Prisma.InputJsonValue) : Prisma.DbNull;
    await prisma.$transaction(async (tx) => {
        await touchOrder(tx, input.orderId, actor, input.version);
        if (input.lineId) {
            await tx.hospitalityOrderLine.updateMany({ where: { id: input.lineId, orderId: input.orderId }, data: { discount } });
        } else {
            await tx.hospitalityOrder.update({ where: { id: input.orderId }, data: { discount } });
        }
        await audit(tx, actor, { venueId: order.venueId, orderId: input.orderId, subjectId: input.lineId, kind: "order.discount", payload: { discount: value } });
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
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
export async function pay(input: PayInput, actor: Actor): Promise<{ closed: boolean; ticketNo: string | null; due: number; }> {
    const head = await prisma.hospitalityOrder.findUnique({ where: { id: input.orderId }, select: { venueId: true, status: true, ticketNo: true } });
    if (!head) throw new HospitalityRefusal("orders.gone");
    ownVenue(actor, head.venueId);
    if (head.status === "void") throw new HospitalityRefusal("orders.closed");
    const shift = await openShift(head.venueId);
    if (!shift) throw new HospitalityRefusal("till.noShift");
    const venue = await prisma.hospitalityVenue.findUnique({ where: { id: head.venueId }, select: { ticketPrefix: true } });
    const year = new Date().getFullYear();
    const result = await prisma.$transaction(async (tx) => {
        // A payment already stored (a retry, a queue replayed) answers what it did, before any lock.
        const stored = await tx.hospitalityPayment.findMany({ where: { id: { in: input.payments.map((p) => p.id) } }, select: { id: true } });
        const storedIds = new Set(stored.map((p) => p.id));
        const fresh = input.payments.filter((p) => !storedIds.has(p.id));
        if (head.status === "paid" || fresh.length === 0) return null;
        // The lock: a second till paying the same table waits here and then sees this payment.
        await touchOrder(tx, input.orderId, actor);
        const order = await tx.hospitalityOrder.findUniqueOrThrow({ where: { id: input.orderId }, include: { lines: true, payments: true } });
        const totals = orderTotals(
            order.lines.map((l) => ({ ...l, modifiers: Array.isArray(l.modifiers) ? (l.modifiers as never) : [], discount: readDiscount(l.discount) })),
            readDiscount(order.discount)
        );
        const paidBefore = order.payments.reduce((s, p) => s + p.amount, 0);
        const paidNow = fresh.reduce((s, p) => s + p.amount, 0);
        if (paidBefore + paidNow > totals.total) throw new HospitalityRefusal("till.overpaid");
        // An item already paid for on another till cannot be paid for again.
        const paidLines = new Set(order.payments.flatMap((p) => p.lineIds));
        if (fresh.some((p) => p.lineIds.some((id) => paidLines.has(id)))) throw new HospitalityRefusal("orders.changed");
        const closes = paidBefore + paidNow === totals.total;
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
                byId: actor.device ? null : actor.id,
                byName: actor.name
            }))
        });
        for (const p of fresh) {
            await audit(tx, actor, {
                venueId: order.venueId,
                orderId: order.id,
                shiftId: shift.id,
                subjectId: p.id,
                kind: "payment.add",
                payload: { method: p.method, amount: p.amount, tip: p.tip, tendered: p.tendered, lineIds: p.lineIds }
            });
        }
        let ticketNo: string | null = null;
        if (closes) {
            const n = await nextNumber(tx, `${order.venueId}:ticket:${year}`);
            ticketNo = `${venue?.ticketPrefix ?? "T"}${year}-${String(n).padStart(6, "0")}`;
            await tx.hospitalityOrder.update({
                where: { id: order.id },
                data: { status: "paid", ticketNo, total: totals.total, shiftId: shift.id, closedAt: new Date() }
            });
            await audit(tx, actor, { venueId: order.venueId, orderId: order.id, shiftId: shift.id, kind: "order.paid", payload: { ticketNo, total: totals.total } });
        }
        return { closed: closes, ticketNo, due: Math.max(0, totals.total - paidBefore - paidNow) };
    });
    if (result) {
        publishHospitalityChange({ venueId: head.venueId, actorId: actor.id, topic: "cash" });
        return result;
    }
    // Nothing new: answer the order as it stands.
    const now = await prisma.hospitalityOrder.findUniqueOrThrow({ where: { id: input.orderId }, include: { lines: true, payments: { select: { amount: true } } } });
    const totals = orderTotals(
        now.lines.map((l) => ({ ...l, modifiers: Array.isArray(l.modifiers) ? (l.modifiers as never) : [], discount: readDiscount(l.discount) })),
        readDiscount(now.discount)
    );
    const paid = now.payments.reduce((s, p) => s + p.amount, 0);
    return { closed: now.status === "paid", ticketNo: now.ticketNo, due: now.status === "paid" ? 0 : Math.max(0, totals.total - paid) };
}

/** The bill asked for: the table shows it, nothing else changes. */
export async function markBilled(orderId: string, actor: Actor): Promise<void> {
    const order = await prisma.hospitalityOrder.findUnique({ where: { id: orderId }, select: { venueId: true } });
    if (!order) throw new HospitalityRefusal("orders.gone");
    ownVenue(actor, order.venueId);
    await prisma.$transaction(async (tx) => {
        await touchOrder(tx, orderId, actor);
        await tx.hospitalityOrder.update({ where: { id: orderId }, data: { status: "billed" } });
        await audit(tx, actor, { venueId: order.venueId, orderId, kind: "order.billed" });
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
}

export async function startShift(venueId: string, float: number, actor: Actor) {
    if (await openShift(venueId)) throw new HospitalityRefusal("till.shiftOpen");
    try {
        const shift = await prisma.$transaction(async (tx) => {
            const made = await tx.hospitalityShift.create({
                data: { venueId, float, openedById: actor.device ? null : actor.id, openedByName: actor.name },
                select: { id: true }
            });
            await audit(tx, actor, { venueId, shiftId: made.id, kind: "shift.open", payload: { float } });
            return made;
        });
        publishHospitalityChange({ venueId, actorId: actor.id, topic: "cash" });
        return shift.id;
    } catch (caught) {
        // Two tills opening at once: the database keeps one open shift per venue.
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002") throw new HospitalityRefusal("till.shiftOpen");
        throw caught;
    }
}

export async function moveCash(input: CashMoveInput, actor: Actor): Promise<void> {
    const shift = await openShift(input.venueId);
    if (!shift) throw new HospitalityRefusal("till.noShift");
    await prisma.$transaction(async (tx) => {
        const made = await tx.hospitalityCashMove.createMany({
            data: [{ id: input.id, shiftId: shift.id, kind: input.kind, amount: input.amount, reason: input.reason, byId: actor.device ? null : actor.id, byName: actor.name }],
            skipDuplicates: true
        });
        if (made.count > 0) {
            await audit(tx, actor, { venueId: input.venueId, shiftId: shift.id, subjectId: input.id, kind: "cash.move", payload: { kind: input.kind, amount: input.amount, reason: input.reason } });
        }
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
export async function closeShift(venueId: string, counted: number, actor: Actor) {
    const shift = await openShift(venueId);
    if (!shift) throw new HospitalityRefusal("till.noShift");
    const report = await reportOf(shift);
    const expected = report.expected;
    const zNumber = await prisma.$transaction(async (tx) => {
        // Only an open shift closes: a second Z at the same moment is refused (and its number
        // rolled back with it), never a renumbered one. A closed shift is immutable in the database.
        const n = await nextNumber(tx, `${venueId}:z`);
        const closing = await tx.hospitalityShift.updateMany({
            where: { id: shift.id, closedAt: null },
            data: { closedAt: new Date(), closedById: actor.device ? null : actor.id, closedByName: actor.name, counted, expected, zNumber: n }
        });
        if (closing.count === 0) throw new HospitalityRefusal("till.noShift");
        await audit(tx, actor, { venueId, shiftId: shift.id, kind: "shift.close", payload: { zNumber: n, counted, expected } });
        return n;
    });
    publishHospitalityChange({ venueId, actorId: actor.id, topic: "cash" });
    return { zNumber, counted, expected, difference: counted - expected, report };
}
