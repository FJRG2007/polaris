/**
 * Inputs of the kitchen display, discounts, payments and the till. Ids of
 * payments and cash movements are made by the device, so a retry stores one.
 */

import { z } from "zod";

const id = z.string().uuid();
const cents = z.number().int().min(0).max(100_000_000);

export const kitchenInput = z.object({ venueId: id, station: z.string().trim().min(1).max(40).nullable().default(null) });

/** A screen's own load: the venue it used last (null: none yet), resolved on the server. */
export const kitchenScreenInput = kitchenInput.extend({ venueId: id.nullable() });

export const tillScreenInput = z.object({ venueId: id.nullable() });

export const markInput = z.object({ lineIds: z.array(id).min(1).max(200), ready: z.boolean() });

export const discountInput = z.object({
    orderId: id,
    /** The order version the device showed; a change on a stale view is refused. */
    version: z.number().int().min(0).optional(),
    lineId: id.nullable().default(null),
    discount: z
        .object({
            kind: z.enum(["percent", "amount"]),
            /** Basis points for percent (up to 100 %), cents for amount. */
            value: z.number().int().min(1).max(100_000_000),
            reason: z.string().trim().max(80).default("")
        })
        .refine((d) => d.kind !== "percent" || d.value <= 10_000, { path: ["value"] })
        .nullable()
});
export type DiscountInput = z.infer<typeof discountInput>;

export const PAYMENT_METHODS = ["cash", "card", "other"] as const;

export const payInput = z.object({
    orderId: id,
    payments: z
        .array(
            z
                .object({
                    id,
                    method: z.enum(PAYMENT_METHODS),
                    amount: cents.min(1),
                    tip: cents.default(0),
                    /** Cash handed over; 0 for card. Never less than what it pays. */
                    tendered: cents.default(0),
                    /** The lines it covers, when the bill is split by item. */
                    lineIds: z.array(id).max(200).default([])
                })
                .refine((p) => p.method !== "cash" || p.tendered === 0 || p.tendered >= p.amount + p.tip, { path: ["tendered"] })
        )
        .min(1)
        .max(20)
});
export type PayInput = z.infer<typeof payInput>;

export const orderOnly = z.object({ orderId: id });

export const shiftOpenInput = z.object({ venueId: id, float: cents });

export const shiftCloseInput = z.object({ venueId: id, counted: cents });

export const cashMoveInput = z.object({
    id,
    venueId: id,
    kind: z.enum(["in", "out"]),
    amount: cents.min(1),
    reason: z.string().trim().max(120).default("")
});
export type CashMoveInput = z.infer<typeof cashMoveInput>;
