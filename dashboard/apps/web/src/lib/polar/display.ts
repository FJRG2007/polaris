/**
 * What a Polar chat shows, per person: tokens and estimated cost under each
 * answer, the context bar above the composer, and whether a turn that would
 * fill the model's window compacts the chat first. Every one is on until the
 * person turns it off, and the defaults live here so an install whose
 * database has no row yet behaves the same. Client-safe.
 */

import { z } from "zod";

export const POLAR_DISPLAY_KEYS = [
    "showTokens",
    "showCost",
    "showContextBar",
    "autoCompact"
] as const;

export type PolarDisplayKey = (typeof POLAR_DISPLAY_KEYS)[number];

export type PolarDisplay = Record<PolarDisplayKey, boolean>;

export const POLAR_DISPLAY_DEFAULTS: PolarDisplay = {
    showTokens: true,
    showCost: true,
    showContextBar: true,
    autoCompact: true
};

/** A stored or cached value read whole: anything missing or not a boolean
 *  falls back to its default. */
export function displayOf(value: unknown): PolarDisplay {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const display = { ...POLAR_DISPLAY_DEFAULTS };
    for (const key of POLAR_DISPLAY_KEYS) {
        if (typeof source[key] === "boolean") display[key] = source[key];
    }
    return display;
}

/** A change to Polar's settings: any of the display switches, memory, or both. */
export const polarPreferencesPatchSchema = z
    .object({
        memory: z.boolean().optional(),
        showTokens: z.boolean().optional(),
        showCost: z.boolean().optional(),
        showContextBar: z.boolean().optional(),
        autoCompact: z.boolean().optional()
    })
    .strict()
    .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
        message: "empty"
    });

export type PolarPreferencesPatch = z.infer<typeof polarPreferencesPatchSchema>;
