/**
 * Fields somebody adds to a kind of record: what one may be called and hold,
 * checked the same way in the browser and on the server.
 *
 * Client-safe: no server module is imported.
 */

import { z } from "zod";
import { CUSTOM_KINDS, slotFamily, slotOf, type CustomKind, type FieldDef } from "./objects";

/** The longest name a field or one of its choices may have. */
export const FIELD_LABEL_MAX = 60;
/** The most choices one select field holds. */
export const MAX_OPTIONS = 50;
/** A new column's width, in pixels. */
export const CUSTOM_WIDTH = 170;

/** A name as it is kept: trimmed, its runs of spaces made one. */
export function normalizeLabel(label: string): string {
    return label.trim().replace(/\s+/g, " ");
}

const label = z
    .string()
    .transform(normalizeLabel)
    .pipe(z.string().min(1, "required").max(FIELD_LABEL_MAX, "tooLong"));

/**
 * A field as it is typed: a name, a kind, and for a select its choices - each
 * named, none twice. Choices of any other kind are dropped.
 */
export const fieldInputSchema = z
    .object({
        label,
        kind: z.enum(CUSTOM_KINDS),
        options: z.array(label).max(MAX_OPTIONS, "tooMany").default([])
    })
    .transform((input) => ({
        ...input,
        options: input.kind === "select" ? input.options : []
    }))
    .superRefine((input, context) => {
        if (input.kind !== "select") return;
        if (input.options.length === 0) {
            context.addIssue({ code: "custom", path: ["options"], message: "noOptions" });
        }
        const seen = new Set<string>();
        input.options.forEach((option, index) => {
            const key = option.toLowerCase();
            if (seen.has(key)) {
                context.addIssue({ code: "custom", path: ["options", index], message: "duplicate" });
            }
            seen.add(key);
        });
    });

export type FieldInput = z.output<typeof fieldInputSchema>;

/** One added field as the screens receive it, and as it is stored. */
export interface CustomField {
    readonly id: string;
    readonly slot: string;
    readonly label: string;
    readonly kind: CustomKind;
    readonly options: readonly string[];
}

/** An added field as every screen draws it: a field like the built-in ones. */
export function customDef(field: CustomField): FieldDef {
    return {
        key: field.slot,
        kind: field.kind,
        label: field.label,
        custom: true,
        width: CUSTOM_WIDTH,
        ...(field.kind === "select" ? { options: field.options } : {})
    };
}

/** Whether a stored row still describes a field: a known kind in the slot
 *  family that kind is kept in. */
export function validStored(kind: string, slot: string): kind is CustomKind {
    return (CUSTOM_KINDS as readonly string[]).includes(kind) && slotOf(slot) === slotFamily(kind as CustomKind);
}
