/**
 * What a Polar chat shows, per person: tokens and estimated cost under each
 * answer, the context bar above the composer, and whether a turn that would
 * fill the model's window compacts the chat first. Every one is on until the
 * person turns it off, and the defaults live here so an install whose
 * database has no row yet behaves the same. Client-safe.
 */

import { z } from "zod";
import { PAYERS } from "@/lib/polar/shared";
import { transcriptionChoiceSchema } from "@/lib/polar/transcription";

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

/**
 * The model Polar's small jobs - thread titles and the suggested next message
 * - are written with. Null is Automatic: the fastest model the person can use.
 */
export const polarHelperModelSchema = z
    .object({
        provider: z.string().trim().min(1).max(64),
        model: z.string().trim().min(1).max(200),
        payer: z.enum(PAYERS).nullable().default(null)
    })
    .strict();

export type PolarHelperModel = z.infer<typeof polarHelperModelSchema>;

/** A stored helper model read whole: anything unreadable is Automatic. */
export function helperModelOf(value: unknown): PolarHelperModel | null {
    const parsed = polarHelperModelSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** A change to Polar's settings: any of the display switches, memory, the
 *  dictation model, the suggested next message, and the helper model. */
export const polarPreferencesPatchSchema = z
    .object({
        memory: z.boolean().optional(),
        suggestions: z.boolean().optional(),
        helperModel: polarHelperModelSchema.nullable().optional(),
        showTokens: z.boolean().optional(),
        showCost: z.boolean().optional(),
        showContextBar: z.boolean().optional(),
        autoCompact: z.boolean().optional(),
        /** The mic menu's model, `provider/model`; null goes back to the default. */
        transcriptionModel: transcriptionChoiceSchema.nullable().optional()
    })
    .strict()
    .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
        message: "empty"
    });

export type PolarPreferencesPatch = z.infer<typeof polarPreferencesPatchSchema>;
