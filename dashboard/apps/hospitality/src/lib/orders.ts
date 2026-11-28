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
import { prisma } from "@polaris/db";
import { HospitalityRefusal } from "./outcome";
import { publishHospitalityChange } from "./live";
import type { AddLinesInput, FloorInput, OpenOrderInput } from "../model/order-schemas";
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

const LIVE = ["open", "billed"];

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
                payments: { select: { amount: true } }
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
                paid: order.payments.reduce((sum, p) => sum + p.amount, 0)
            };
        })
    };
}

/**
 * Opens an order, or answers the one already open at that table: two waiters
 * tapping the same free table at once end up on the same order, not two.
 */
export async function openOrder(input: OpenOrderInput, actor: { id: string; name: string }): Promise<string> {
    const existing = await prisma.hospitalityOrder.findUnique({ where: { id: input.id }, select: { id: true } });
    if (existing) return existing.id;
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
    await prisma.hospitalityOrder.createMany({
        data: [
            {
                id: input.id,
                venueId: input.venueId,
                tableId: input.tableId,
                label: input.label,
                covers: input.covers,
                waiterId: actor.id,
                waiterName: actor.name
            }
        ],
        skipDuplicates: true
    });
    publishHospitalityChange({ venueId: input.venueId, actorId: actor.id, topic: "orders" });
    return input.id;
}

async function liveOrder(orderId: string) {
    const order = await prisma.hospitalityOrder.findUnique({
        where: { id: orderId },
        select: { id: true, venueId: true, status: true }
    });
    if (!order) throw new HospitalityRefusal("orders.gone");
    if (!LIVE.includes(order.status)) throw new HospitalityRefusal("orders.closed");
    return order;
}

/**
 * Adds lines at the menu's price for the order's venue. A line id already
 * stored is skipped, so a replay adds nothing. A product that is sold out or
 * gone is refused by name, so the waiter can tell the table.
 */
export async function addLines(input: AddLinesInput, actor: { id: string; name: string }): Promise<void> {
    const order = await liveOrder(input.orderId);
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
        // The price of each chosen option comes from the product, never from the device.
        const groups = z
            .array(z.object({ options: z.array(z.object({ id: z.string(), name: z.string(), price: z.number().int() })) }))
            .safeParse(p.modifiers ?? []);
        const options = new Map((groups.success ? groups.data : []).flatMap((g) => g.options).map((opt) => [opt.id, opt]));
        const modifiers = line.modifierIds.flatMap((id) => {
            const opt = options.get(id);
            return opt ? [{ name: opt.name, price: opt.price }] : [];
        });
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
    await prisma.hospitalityOrderLine.createMany({ data: rows, skipDuplicates: true });
    publishHospitalityChange({ venueId: order.venueId, actorId: actor.id, topic: "orders" });
}

/** Fires what is still pending ("marchar"): all of it, or one course. */
export async function sendLines(orderId: string, course: number | null, actorId: string): Promise<number> {
    const order = await liveOrder(orderId);
    const sent = await prisma.hospitalityOrderLine.updateMany({
        where: { orderId, status: "pending", ...(course === null ? {} : { course }) },
        data: { status: "sent", sentAt: new Date() }
    });
    publishHospitalityChange({ venueId: order.venueId, actorId, topic: "kitchen" });
    return sent.count;
}

/** A pending line is simply removed; a sent one is voided so the kitchen sees it. */
export async function removeLine(lineId: string, actorId: string): Promise<void> {
    const line = await prisma.hospitalityOrderLine.findUnique({ where: { id: lineId }, select: { orderId: true, status: true } });
    if (!line) return;
    const order = await liveOrder(line.orderId);
    if (line.status === "pending") await prisma.hospitalityOrderLine.delete({ where: { id: lineId } });
    else await prisma.hospitalityOrderLine.update({ where: { id: lineId }, data: { status: "void" } });
    publishHospitalityChange({ venueId: order.venueId, actorId, topic: "orders" });
}

/** Moves an order to another free table, or merges it into the order already there. */
export async function moveOrder(orderId: string, tableId: string, actorId: string): Promise<string> {
    const order = await liveOrder(orderId);
    const target = await prisma.hospitalityOrder.findFirst({
        where: { tableId, status: { in: LIVE }, id: { not: orderId } },
        select: { id: true }
    });
    if (target) {
        await prisma.$transaction([
            prisma.hospitalityOrderLine.updateMany({ where: { orderId }, data: { orderId: target.id } }),
            prisma.hospitalityPayment.updateMany({ where: { orderId }, data: { orderId: target.id } }),
            prisma.hospitalityOrder.update({ where: { id: orderId }, data: { status: "void", closedAt: new Date() } })
        ]);
    } else {
        await prisma.hospitalityOrder.update({ where: { id: orderId }, data: { tableId } });
    }
    publishHospitalityChange({ venueId: order.venueId, actorId, topic: "orders" });
    return target?.id ?? orderId;
}

/** Saves a room's plan: tables kept are moved, new ones made, missing ones removed. */
export async function saveFloor(input: FloorInput, actorId: string): Promise<string> {
    const room = input.roomId
        ? await prisma.hospitalityRoom.update({ where: { id: input.roomId }, data: { name: input.name }, select: { id: true, venueId: true } })
        : await prisma.hospitalityRoom.create({ data: { venueId: input.venueId, name: input.name, position: Date.now() }, select: { id: true, venueId: true } });
    const keep = input.tables.flatMap((t) => (t.id ? [t.id] : []));
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
