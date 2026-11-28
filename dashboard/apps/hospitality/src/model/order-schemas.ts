/**
 * Inputs of the floor and the order screens. Ids of orders and lines are made
 * by the device (`crypto.randomUUID()`), which is what lets a retried or
 * replayed request change nothing the second time.
 */

import { z } from "zod";

const id = z.string().uuid();

/** The order version the device showed; a change on a stale view is refused. */
const version = z.number().int().min(0).optional();

export const TABLE_SHAPES = ["square", "round", "long"] as const;

export const venueOnly = z.object({ venueId: id });

export const openOrderInput = z.object({
    id,
    venueId: id,
    tableId: id.nullable(),
    label: z.string().trim().max(60).default(""),
    covers: z.number().int().min(0).max(500).default(0)
});
export type OpenOrderInput = z.infer<typeof openOrderInput>;

export const addLinesInput = z.object({
    orderId: id,
    lines: z
        .array(
            z.object({
                id,
                productId: id,
                quantity: z.number().int().min(1).max(999),
                modifierIds: z.array(z.string().min(1).max(40)).max(40).default([]),
                note: z.string().trim().max(200).default(""),
                course: z.number().int().min(0).max(9).default(0)
            })
        )
        .min(1)
        .max(200)
});
export type AddLinesInput = z.infer<typeof addLinesInput>;

export const sendInput = z.object({ orderId: id, course: z.number().int().min(0).max(9).nullable().default(null) });

export const lineOnly = z.object({ lineId: id, version });

export const moveInput = z.object({ orderId: id, tableId: id, version });

export const splitInput = z.object({
    orderId: id,
    version,
    tableId: id,
    /** Used only when the table has no order yet. */
    targetOrderId: id,
    lines: z
        .array(z.object({ lineId: id, quantity: z.number().int().min(1).max(999), newLineId: id }))
        .min(1)
        .max(200)
});
export type SplitInput = z.infer<typeof splitInput>;

export const floorInput = z.object({
    venueId: id,
    roomId: id.nullable(),
    name: z.string().trim().min(1).max(60),
    tables: z
        .array(
            z.object({
                id: id.nullable(),
                name: z.string().trim().min(1).max(12),
                x: z.number().min(0).max(200),
                y: z.number().min(0).max(200),
                width: z.number().min(1).max(20),
                height: z.number().min(1).max(20),
                shape: z.enum(TABLE_SHAPES),
                seats: z.number().int().min(1).max(60)
            })
        )
        .max(300)
});
export type FloorInput = z.infer<typeof floorInput>;
