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
            // i18n-ignore a code the form reads as customFields.invalid.noOptions
            context.addIssue({ code: "custom", path: ["options"], message: "noOptions" });
        }
        const seen = new Set<string>();
        input.options.forEach((option, index) => {
            const key = option.toLowerCase();
            if (seen.has(key)) {
                context.addIssue({
                    code: "custom",
                    path: ["options", index],
                    message: "duplicate"
                });
            }
            seen.add(key);
        });
    });

export type FieldInput = z.output<typeof fieldInputSchema>;

/**
 * Choices of a select that were edited rather than replaced: the records that
 * held `from` hold `to` after the save, instead of being left with no choice.
 */
export const choiceRenamesSchema = z
    .array(z.object({ from: label, to: label }))
    .max(MAX_OPTIONS)
    .default([]);

export type ChoiceRename = z.output<typeof choiceRenamesSchema>[number];

/**
 * What saving a select's choices does to the records: which choices carry
 * their records over to a new wording, and which are gone and leave their
 * records with no choice. A rename counts only from a choice that is gone to
 * one that is new, each once.
 */
export function choiceChanges(
    before: readonly string[],
    after: readonly string[],
    renames: readonly ChoiceRename[]
): { renamed: ChoiceRename[]; removed: string[] } {
    const renamed: ChoiceRename[] = [];
    const from = new Set<string>();
    const to = new Set<string>();
    for (const rename of renames) {
        if (from.has(rename.from) || to.has(rename.to)) continue;
        if (!before.includes(rename.from) || after.includes(rename.from)) continue;
        if (!after.includes(rename.to) || before.includes(rename.to)) continue;
        from.add(rename.from);
        to.add(rename.to);
        renamed.push(rename);
    }
    const removed = before.filter((option) => !after.includes(option) && !from.has(option));
    return { renamed, removed };
}

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
    return (
        (CUSTOM_KINDS as readonly string[]).includes(kind) &&
        slotOf(slot) === slotFamily(kind as CustomKind)
    );
}
