/**
 * What a printer is asked to print, before it is bytes.
 *
 * A receipt, a kitchen order and a test page are all a list of blocks. The
 * hospitality app turns its own ticket into one of these (`ticketToPrint`); the
 * encoder never sees an order, a table or a price, only lines to lay out. The
 * schema bounds every field so a document read from a request cannot ask the
 * encoder for an unbounded amount of work.
 */

import { z } from "zod";

const text = z.string().max(2000);

const style = {
    align: z.enum(["left", "center", "right"]).optional(),
    bold: z.boolean().optional(),
    underline: z.boolean().optional(),
    invert: z.boolean().optional(),
    /** "wide" and "large" halve the columns a line has. */
    size: z.enum(["normal", "tall", "wide", "large"]).optional(),
    /** Second ribbon colour on a two-colour impact printer (TM-U220): usually red. */
    red: z.boolean().optional()
};

export const printBlockSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text, ...style }).strict(),
    z
        .object({
            type: z.literal("row"),
            left: text,
            right: z.string().max(200),
            bold: style.bold,
            size: style.size,
            red: style.red
        })
        .strict(),
    z.object({ type: z.literal("rule"), char: z.string().length(1).optional() }).strict(),
    z.object({ type: z.literal("feed"), lines: z.number().int().min(1).max(20) }).strict(),
    z
        .object({
            type: z.literal("qr"),
            data: z.string().min(1).max(700),
            /** Module size in dots, 1-16 (Epson GS ( k function 167). */
            size: z.number().int().min(1).max(16).optional(),
            align: style.align
        })
        .strict(),
    z
        .object({
            type: z.literal("image"),
            /** Width in dots; a multiple of 8, at most the paper's printable width. */
            width: z.number().int().min(8).max(832).multipleOf(8),
            height: z.number().int().min(1).max(1200),
            /** One bit per dot, rows top to bottom, the high bit leftmost, base64. */
            bits: z.string().max(200_000),
            align: style.align
        })
        .strict(),
    z.object({ type: z.literal("cut"), partial: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("drawer"), pin: z.union([z.literal(2), z.literal(5)]).optional() }).strict(),
    z.object({ type: z.literal("beep"), times: z.number().int().min(1).max(9).optional() }).strict()
]);

export type PrintBlock = z.infer<typeof printBlockSchema>;

export const printDocumentSchema = z.object({ blocks: z.array(printBlockSchema).min(1).max(1000) }).strict();

export type PrintDocument = z.infer<typeof printDocumentSchema>;
