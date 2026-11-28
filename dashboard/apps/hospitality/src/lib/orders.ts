/**
 * The floor and its orders. Every function is called by an action that has
 * already checked the permission and validated its input.
 *
 * Ids of orders and lines are made by the device that took them, so a device
 * that sends the same thing twice (a retry, a queue replayed after the network
 * came back) changes nothing the second time. Prices are always read here,
 * from the menu as the venue sells it, never taken from the device; totals are
 * always computed here with the same arithmetic the screen shows.
 *
 * Server-only.
 */

import { z } from "zod";
import { chooseModifiers } from "../model/modifiers";
import { modifierGroupSchema } from "../model/schemas";
import { Prisma, prisma } from "@polaris/db";
import { HospitalityRefusal } from "./outcome";
import { audit, LIVE, ownVenue, touchOrder, type Actor } from "./audit";
import { publishHospitalityChange } from "./live";
import type { AddLinesInput, FloorInput, OpenOrderInput, SplitInput } from "../model/order-schemas";
import { orderTotals, type Discount, type OrderTotals, type PricedModifier } from "../model/pricing";

export interface TableView {
    readonly id: string;
    readonly roomId: string;
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly shape: string;
    readonly seats: number;
}

export interface RoomView {
    readonly id: string;
    readonly name: string;
    readonly tables: TableView[];
}

export interface LineView {
    readonly id: string;
    readonly productId: string | null;
    readonly name: string;
    readonly unitPrice: number;
    readonly taxRateBp: number;
    readonly quantity: number;
    readonly modifiers: PricedModifier[];
    readonly note: string;
    readonly course: number;
    readonly station: string;
    readonly status: string;
    readonly discount: Discount | null;
    readonly sentAt: string | null;
    readonly byName: string;
}

export interface OrderView {
    readonly id: string;
    readonly tableId: string | null;
    readonly label: string;
    readonly status: string;
    readonly covers: number;
    readonly waiterName: string;
    readonly note: string;
    readonly openedAt: string;
    readonly discount: Discount | null;
    readonly lines: LineView[];
    readonly totals: OrderTotals;
    readonly paid: number;
    /** Lines already paid for by item, so a split shows only what is left. */
    readonly paidLineIds: string[];
    /** Sent back with a change, so a change made on a stale view is refused. */
    readonly version: number;
    readonly updatedByName: string;
}

export interface ServiceView {
    readonly rooms: RoomView[];
    readonly orders: OrderView[];
}

const discountSchema = z.object({ kind: z.enum(["percent", "amount"]), value: z.number(), reason: z.string() });
const modifiersSchema = z.array(z.object({ name: z.string(), price: z.number().int() }));

/** Stored JSON read total: anything unreadable is no discount, no modifiers. */
export function readDiscount(raw: unknown): Discount | null {
    const parsed = discountSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

function readModifiers(raw: unknown): PricedModifier[] {
    const parsed = modifiersSchema.safeParse(raw ?? []);
    return parsed.success ? parsed.data : [];
}

/** A venue's rooms and tables and every order still open, with its totals. */
export async function readService(venueId: string): Promise<ServiceView> {
    const [rooms, orders] = await Promise.all([
        prisma.hospitalityRoom.findMany({
            where: { venueId },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            include: { tables: { orderBy: { createdAt: "asc" } } },
            take: 50
        }),
        prisma.hospitalityOrder.findMany({
            where: { venueId, status: { in: LIVE } },
            orderBy: { openedAt: "asc" },
            include: {
                lines: { orderBy: { createdAt: "asc" } },
                payments: { select: { amount: true, lineIds: true } }
            },
            take: 500
        })
    ]);
    return {
        rooms: rooms.map((room) => ({
            id: room.id,
            name: room.name,
            tables: room.tables.map((t) => ({
                id: t.id,
                roomId: t.roomId,
                name: t.name,
                x: t.x,
                y: t.y,
                width: t.width,
                height: t.height,
                shape: t.shape,
                seats: t.seats
            }))
        })),
        orders: orders.map((order) => {
            const lines: LineView[] = order.lines.map((line) => ({
                id: line.id,
                productId: line.productId,
                name: line.name,
                unitPrice: line.unitPrice,
                taxRateBp: line.taxRateBp,
                quantity: line.quantity,
                modifiers: readModifiers(line.modifiers),
                note: line.note,
                course: line.course,
                station: line.station,
                status: line.status,
                discount: readDiscount(line.discount),
                sentAt: line.sentAt?.toISOString() ?? null,
                byName: line.byName
            }));
            const discount = readDiscount(order.discount);
            return {
                id: order.id,
                tableId: order.tableId,
                label: order.label,
                status: order.status,
                covers: order.covers,
                waiterName: order.waiterName,
                note: order.note,
                openedAt: order.openedAt.toISOString(),
                discount,
                lines,
                totals: orderTotals(lines, discount),
                paid: order.payments.reduce((sum, p) => sum + p.amount, 0),
                paidLineIds: order.payments.flatMap((p) => p.lineIds),
                version: order.version,
                updatedByName: order.updatedByName
            };
        })
    };
}

/**
 * Opens an order, or answers the one already open at that table: two waiters
 * tapping the same free table at once end up on the same order, not two.
 */
export async function openOrder(input: OpenOrderInput, actor: Actor): Promise<string> {
    ownVenue(actor, input.venueId);
    const existing = await prisma.hospitalityOrder.findUnique({ where: { id: input.id }, select: { id: true, venueId: true } });
    if (existing) {
        ownVenue(actor, existing.venueId);
        return existing.id;
    }
    if (input.tableId) {
        const table = await prisma.hospitalityTable.findFirst({
            where: { id: input.tableId, room: { venueId: input.venueId } },
            select: { id: true }
        });
        if (!table) throw new HospitalityRefusal("orders.tableGone");
        const open = await prisma.hospitalityOrder.findFirst({
            where: { tableId: input.tableId, status: { in: LIVE } },
            select: { id: true }
        });
        if (open) return open.id;
    }
    try {
        await createOrder(input, actor);
    } catch (caught) {
        // Another device opened this table a moment ago: both end up on that order.
        if (!(caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002") || !input.tableId) throw caught;
        const open = await prisma.hospitalityOrder.findFirst({ where: { tableId: input.tableId, status: { in: LIVE } }, select: { id: true } });
        if (!open) throw caught;
        return open.id;
    }
    publishHospitalityChange({ venueId: input.venueId, actorId: actor.id, topic: "orders" });
    return input.id;
}

function createOrder(input: OpenOrderInput, actor: Actor) {
    return prisma.$transaction(async (tx) => {
        const made = await tx.hospitalityOrder.createMany({
            data: [
                {
                    id: input.id,
                    venueId: input.venueId,
                    tableId: input.tableId,
                    label: input.label,
                    covers: input.covers,
                    waiterId: actor.device ? null : actor.id,
                    waiterName: actor.name,
                    updatedByName: actor.name
                }
            ],
            skipDuplicates: true
        });
        if (made.count > 0) {
            await audit(tx, actor, { venueId: input.venueId, orderId: input.id, kind: "order.open", payload: { tableId: input.tableId, label: input.label, covers: input.covers } });
        }
    });
}

async function paidInClosedShift(orderId: string): Promise<boolean> {
    const payments = await prisma.hospitalityPayment.findMany({ where: { orderId, shiftId: { not: null } }, select: { shiftId: true } });
    const shifts = [...new Set(payments.flatMap((p) => (p.shiftId ? [p.shiftId] : [])))];
    if (shifts.length === 0) return false;
    return (await prisma.hospitalityShift.count({ where: { id: { in: shifts }, closedAt: { not: null } } })) > 0;
}

async function liveOrder(orderId: string, actor: Actor) {
    const order = await prisma.hospitalityOrder.findUnique({
        where: { id: orderId },
        select: { id: true, venueId: true, status: true }
    });
    if (!order) throw new HospitalityRefusal("orders.gone");
    ownVenue(actor, order.venueId);
    if (!LIVE.includes(order.status)) throw new HospitalityRefusal("orders.closed");
    return order;
}

/**
 * Adds lines at the menu's price for the order's venue. A line id already
 * stored is skipped, so a replay adds nothing. A product that is sold out or
 * gone is refused by name, so the waiter can tell the table. Adding never
 * needs the version the device saw: two waiters adding to one table both land.
 */
export async function addLines(input: AddLinesInput, actor: Actor): Promise<void> {
    const order = await liveOrder(input.orderId, actor);
    const ids = [...new Set(input.lines.map((l) => l.productId))];
    const [products, overrides, stored] = await Promise.all([
        prisma.hospitalityProduct.findMany({
            where: { id: { in: ids } },
            include: { category: { select: { station: true } } }
        }),
        prisma.hospitalityPriceOverride.findMany({ where: { venueId: order.venueId, productId: { in: ids } } }),
        prisma.hospitalityOrderLine.findMany({
            where: { id: { in: input.lines.map((l) => l.id) } },
            select: { id: true }
        })
    ]);
    const known = new Set(stored.map((s) => s.id));
    const fresh = input.lines.filter((l) => !known.has(l.id));
    if (fresh.length === 0) return;
    const product = new Map(products.map((p) => [p.id, p]));
    const own = new Map(overrides.map((o) => [o.productId, o]));
    const rows = fresh.map((line) => {
        const p = product.get(line.productId);
        const o = own.get(line.productId);
        if (!p || !p.available || o?.available === false) throw new HospitalityRefusal("orders.soldOut");
        // The price of each chosen option comes from the product, never from the device,
        // and a line missing a required choice (or with too many) is refused.
        const groups = z.array(modifierGroupSchema).safeParse(p.modifiers ?? []);
        const choice = chooseModifiers(groups.success ? groups.data : [], line.modifierIds);
        if (!choice.ok) throw new HospitalityRefusal("orders.modifiers");
        const modifiers = choice.modifiers;
        return {
            id: line.id,
            orderId: order.id,
            productId: p.id,
            name: p.name,
            unitPrice: o?.price ?? p.price,
            taxRateBp: p.taxRateBp,
            quantity: line.quantity,
            modifiers,
            note: line.note,
            course: line.course,
            station: p.station ?? p.category.station,
            byName: actor.name
        };
    });
    const added = await prisma.$transaction(async (tx) => {
        await touchOrder(tx, order.id, actor);
        const made = await tx.hospitalityOrderLine.createMany({ data: rows, skipDuplicates: true });
        if (made.count > 0) {
            await audit(tx, actor, {
                venueId: order.venueId,
                orderId: order.id,
                kind: "lines.add",
                payload: { lines: rows.map((r) => ({ id: r.id, name: r.name, quantity: r.quantity, unitPrice: r.unitPrice })) }
            });
        }
        return made.count;
    });
    if (added > 0) publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
}

/** Fires what is still pending ("marchar"): all of it, or one course. */
export async function sendLines(orderId: string, course: number | null, actor: Actor): Promise<number> {
    const order = await liveOrder(orderId, actor);
    const count = await prisma.$transaction(async (tx) => {
        await touchOrder(tx, orderId, actor);
        const sent = await tx.hospitalityOrderLine.updateMany({
            where: { orderId, status: "pending", ...(course === null ? {} : { course }) },
            data: { status: "sent", sentAt: new Date() }
        });
        if (sent.count > 0) await audit(tx, actor, { venueId: order.venueId, orderId, kind: "lines.send", payload: { course, count: sent.count } });
        return sent.count;
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "kitchen" });
    return count;
}

const UNDO_WINDOW_MS = 10 * 60_000;

/**
 * A pending line is simply removed; a sent one is voided so the kitchen sees
 * it. What the line was is kept in the audit event, which is what an undo
 * puts back - never a copy sent by the device.
 */
export async function removeLine(lineId: string, actor: Actor, seen?: number): Promise<void> {
    const line = await prisma.hospitalityOrderLine.findUnique({ where: { id: lineId } });
    if (!line || line.status === "void") return;
    const order = await liveOrder(line.orderId, actor);
    await prisma.$transaction(async (tx) => {
        await touchOrder(tx, order.id, actor, seen);
        if (line.status === "pending") await tx.hospitalityOrderLine.delete({ where: { id: lineId } });
        else await tx.hospitalityOrderLine.update({ where: { id: lineId }, data: { status: "void" } });
        await audit(tx, actor, {
            venueId: order.venueId,
            orderId: order.id,
            subjectId: lineId,
            kind: "line.remove",
            payload: { line: { ...line, createdAt: line.createdAt.toISOString(), sentAt: line.sentAt?.toISOString() ?? null, readyAt: line.readyAt?.toISOString() ?? null } }
        });
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
}

const removedLineSchema = z.object({
    line: z
        .object({
            id: z.string(),
            orderId: z.string(),
            productId: z.string().nullable(),
            name: z.string(),
            unitPrice: z.number().int(),
            taxRateBp: z.number().int(),
            quantity: z.number().int(),
            modifiers: z.unknown(),
            note: z.string(),
            course: z.number().int(),
            station: z.string(),
            status: z.string(),
            discount: z.unknown(),
            byName: z.string()
        })
        .passthrough()
});

/** Undo of a removal: the line comes back as it was, from the audit trail, once. */
export async function restoreLine(lineId: string, actor: Actor): Promise<void> {
    const event = await prisma.hospitalityAuditEvent.findFirst({
        where: { subjectId: lineId, kind: "line.remove", at: { gte: new Date(Date.now() - UNDO_WINDOW_MS) } },
        orderBy: { at: "desc" }
    });
    const parsed = removedLineSchema.safeParse(event?.payload);
    if (!event || !parsed.success) throw new HospitalityRefusal("orders.undoExpired");
    const was = parsed.data.line;
    const order = await liveOrder(was.orderId, actor);
    const restored = await prisma.$transaction(async (tx) => {
        await touchOrder(tx, order.id, actor);
        const now = await tx.hospitalityOrderLine.findUnique({ where: { id: lineId }, select: { status: true } });
        if (now && now.status !== "void") return false;
        if (now) {
            await tx.hospitalityOrderLine.update({ where: { id: lineId }, data: { status: was.status } });
        } else {
            await tx.hospitalityOrderLine.create({
                data: {
                    id: was.id,
                    orderId: was.orderId,
                    productId: was.productId,
                    name: was.name,
                    unitPrice: was.unitPrice,
                    taxRateBp: was.taxRateBp,
                    quantity: was.quantity,
                    modifiers: (was.modifiers ?? []) as Prisma.InputJsonValue,
                    note: was.note,
                    course: was.course,
                    station: was.station,
                    status: was.status,
                    discount: was.discount == null ? Prisma.DbNull : (was.discount as Prisma.InputJsonValue),
                    byName: was.byName
                }
            });
        }
        await audit(tx, actor, { venueId: order.venueId, orderId: order.id, subjectId: lineId, kind: "line.restore", payload: { status: was.status } });
        return true;
    });
    if (restored) publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
}

/** Moves an order to another free table, or merges it into the order already there. */
export async function moveOrder(orderId: string, tableId: string, actor: Actor, seen?: number): Promise<string> {
    const order = await liveOrder(orderId, actor);
    const table = await prisma.hospitalityTable.findFirst({ where: { id: tableId, room: { venueId: order.venueId } }, select: { id: true } });
    if (!table) throw new HospitalityRefusal("orders.tableGone");
    const target = await prisma.hospitalityOrder.findFirst({
        where: { tableId, status: { in: LIVE }, id: { not: orderId } },
        select: { id: true }
    });
    // A payment taken before the till was closed stays with the shift that counted it
    // (a closed Z never changes), so a part-paid order cannot be merged into another.
    // Moving only the unpaid items is the way forward, and the sentence says so.
    if (target && (await paidInClosedShift(orderId))) throw new HospitalityRefusal("orders.paidBeforeClose");
    await prisma.$transaction(async (tx) => {
        await touchOrder(tx, orderId, actor, seen);
        if (target) {
            await touchOrder(tx, target.id, actor);
            await tx.hospitalityOrderLine.updateMany({ where: { orderId }, data: { orderId: target.id } });
            await tx.hospitalityPayment.updateMany({ where: { orderId }, data: { orderId: target.id } });
            await tx.hospitalityOrder.update({ where: { id: orderId }, data: { status: "void", closedAt: new Date() } });
        } else {
            await tx.hospitalityOrder.update({ where: { id: orderId }, data: { tableId } });
        }
        await audit(tx, actor, { venueId: order.venueId, orderId, kind: "order.move", payload: { tableId, mergedInto: target?.id ?? null } });
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
    return target?.id ?? orderId;
}

/**
 * Splits a table: the chosen quantities of the chosen lines go to another
 * table - onto the order already there, or a new one with the id the device
 * made. Part of a line (two of three beers) leaves as a new line with the id
 * the device made, so a replay finds it stored and moves nothing twice.
 */
export async function splitOrder(input: SplitInput, actor: Actor): Promise<string> {
    const order = await liveOrder(input.orderId, actor);
    const table = await prisma.hospitalityTable.findFirst({ where: { id: input.tableId, room: { venueId: order.venueId } }, select: { id: true } });
    if (!table) throw new HospitalityRefusal("orders.tableGone");
    const already = await prisma.hospitalityOrderLine.findMany({ where: { id: { in: input.lines.map((l) => l.newLineId) } }, select: { orderId: true } });
    if (already[0]) return already[0].orderId;
    const existing = await prisma.hospitalityOrder.findFirst({
        where: { tableId: input.tableId, status: { in: LIVE }, id: { not: order.id } },
        select: { id: true }
    });
    const targetId = existing?.id ?? input.targetOrderId;
    await prisma.$transaction(async (tx) => {
        await touchOrder(tx, order.id, actor, input.version);
        // Read under the lock, so the quantities split are the ones stored now.
        const lines = await tx.hospitalityOrderLine.findMany({
            where: { orderId: order.id, id: { in: input.lines.map((l) => l.lineId) }, status: { not: "void" } }
        });
        const byId = new Map(lines.map((l) => [l.id, l]));
        if (existing) {
            await touchOrder(tx, existing.id, actor);
        } else {
            await tx.hospitalityOrder.create({
                data: {
                    id: targetId,
                    venueId: order.venueId,
                    tableId: input.tableId,
                    waiterId: actor.device ? null : actor.id,
                    waiterName: actor.name,
                    updatedByName: actor.name
                }
            });
        }
        for (const move of input.lines) {
            const line = byId.get(move.lineId);
            if (!line) throw new HospitalityRefusal("orders.changed");
            const quantity = Math.min(move.quantity, line.quantity);
            if (quantity === line.quantity) {
                await tx.hospitalityOrderLine.update({ where: { id: line.id }, data: { orderId: targetId } });
                continue;
            }
            const { id: _id, orderId: _orderId, createdAt: _createdAt, ...rest } = line;
            await tx.hospitalityOrderLine.update({ where: { id: line.id }, data: { quantity: line.quantity - quantity } });
            await tx.hospitalityOrderLine.create({
                data: {
                    ...rest,
                    id: move.newLineId,
                    orderId: targetId,
                    quantity,
                    modifiers: (line.modifiers ?? []) as Prisma.InputJsonValue,
                    discount: line.discount === null ? Prisma.DbNull : (line.discount as Prisma.InputJsonValue)
                }
            });
        }
        await audit(tx, actor, {
            venueId: order.venueId,
            orderId: order.id,
            kind: "order.split",
            payload: { targetOrderId: targetId, tableId: input.tableId, lines: input.lines }
        });
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
    return targetId;
}

/** Saves a room's plan: tables kept are moved, new ones made, missing ones removed. */
export async function saveFloor(input: FloorInput, actorId: string): Promise<string> {
    const room = input.roomId
        ? await prisma.hospitalityRoom.update({ where: { id: input.roomId }, data: { name: input.name }, select: { id: true, venueId: true } })
        : await prisma.hospitalityRoom.create({ data: { venueId: input.venueId, name: input.name, position: Date.now() }, select: { id: true, venueId: true } });
    const keep = input.tables.flatMap((t) => (t.id ? [t.id] : []));
    const leaving = await prisma.hospitalityTable.findMany({ where: { roomId: room.id, id: { notIn: keep } }, select: { id: true } });
    const busy = leaving.length
        ? await prisma.hospitalityOrder.count({ where: { status: { in: LIVE }, tableId: { in: leaving.map((x) => x.id) } } })
        : 0;
    if (busy > 0) throw new HospitalityRefusal("orders.tableBusy");
    await prisma.$transaction([
        prisma.hospitalityTable.deleteMany({ where: { roomId: room.id, id: { notIn: keep } } }),
        ...input.tables.map(({ id, ...data }) =>
            id
                ? prisma.hospitalityTable.update({ where: { id }, data })
                : prisma.hospitalityTable.create({ data: { ...data, roomId: room.id } })
        )
    ]);
    publishHospitalityChange({ venueId: room.venueId, actorId, topic: "floor" });
    return room.id;
}

/** Sets how many guests are at the table; every floor redraws its chairs. */
export async function setCovers(orderId: string, covers: number, actor: Actor): Promise<void> {
    const order = await prisma.hospitalityOrder.findUnique({ where: { id: orderId }, select: { venueId: true, status: true, covers: true } });
    if (!order || !LIVE.includes(order.status)) throw new HospitalityRefusal("orders.gone");
    ownVenue(actor, order.venueId);
    if (order.covers === covers) return;
    await prisma.$transaction(async (tx) => {
        await touchOrder(tx, orderId, actor);
        await tx.hospitalityOrder.update({ where: { id: orderId }, data: { covers } });
        await audit(tx, actor, { venueId: order.venueId, orderId, kind: "order.covers", payload: { from: order.covers, to: covers } });
    });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
}
