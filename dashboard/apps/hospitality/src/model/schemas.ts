/**
 * Every input the Hospitality screens send, validated before any work. Text is
 * trimmed before it is checked; amounts are integer cents.
 */

import { z } from "zod";
import { ALLERGEN_KEYS } from "./allergens";

const name = (max: number) => z.string().trim().min(1).max(max);
const cents = z.number().int().min(0).max(100_000_000);
const id = z.string().uuid();

export const CATEGORY_COLORS = ["slate", "red", "orange", "amber", "lime", "green", "teal", "sky", "blue", "violet", "pink"] as const;

export const venueInput = z.object({
    id: id.nullable(),
    name: name(80),
    businessName: z.string().trim().max(120).default(""),
    taxId: z.string().trim().max(32).default(""),
    address: z.string().trim().max(240).default(""),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("EUR"),
    footer: z.string().trim().max(240).default(""),
    ticketPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/).default("T")
});
export type VenueInput = z.infer<typeof venueInput>;

export const categoryInput = z.object({
    id: id.nullable(),
    name: name(80),
    color: z.enum(CATEGORY_COLORS).default("slate"),
    station: z.string().trim().min(1).max(40).default("kitchen")
});
export type CategoryInput = z.infer<typeof categoryInput>;

export const modifierGroupSchema = z.object({
    id: z.string().min(1).max(40),
    name: name(60),
    min: z.number().int().min(0).max(20),
    max: z.number().int().min(1).max(20),
    options: z.array(z.object({ id: z.string().min(1).max(40), name: name(60), price: z.number().int().min(-100_000).max(100_000) })).min(1).max(40)
}).refine((g) => g.min <= g.max, { path: ["min"] });
export type ModifierGroup = z.infer<typeof modifierGroupSchema>;

export const productInput = z.object({
    id: id.nullable(),
    categoryId: id,
    name: name(120),
    description: z.string().trim().max(500).default(""),
    price: cents,
    taxRateBp: z.number().int().min(0).max(10_000),
    allergens: z.array(z.enum(ALLERGEN_KEYS)).max(14).default([]),
    sku: z.string().trim().max(64).nullable().default(null).transform((v) => v || null),
    station: z.string().trim().max(40).nullable().default(null).transform((v) => v || null),
    imageUrl: z.string().trim().max(500).nullable().default(null).transform((v) => v || null)
        .refine((v) => v === null || /^(https?:\/\/|\/)/i.test(v)),
    modifiers: z.array(modifierGroupSchema).max(10).default([]),
    available: z.boolean().default(true)
});
export type ProductInput = z.infer<typeof productInput>;

export const availabilityInput = z.object({ productId: id, venueId: id.nullable(), available: z.boolean() });

export const bulkPriceInput = z.object({
    /** Null: every category. */
    categoryId: id.nullable(),
    kind: z.enum(["percent", "amount"]),
    /** Basis points for percent (-5000..10000), cents for amount. */
    value: z.number().int().min(-100_000).max(100_000),
    roundTo: z.number().int().min(1).max(100).default(1)
});
export type BulkPriceInput = z.infer<typeof bulkPriceInput>;

export const importInput = z.object({ csv: z.string().min(1).max(5_000_000), replacePrices: z.boolean().default(true) });

export const idInput = z.object({ id });
