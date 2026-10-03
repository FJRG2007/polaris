/**
 * The shapes a new row, a removal and a new table may arrive in. The forms check
 * against these as they are filled in, and the actions check again before
 * anything reaches a driver - the same schema on both sides, so the form cannot
 * accept what the server refuses.
 *
 * The messages are the sentences `row-edit.ts` refuses with, so `dataText` puts
 * either in the reader's words.
 */

import { z } from "zod";
import {
    DEFAULT_EXPRESSIONS,
    MAX_DELETE_ROWS,
    MAX_NEW_COLUMNS,
    TABLE_TYPES,
    isPlainIdentifier,
    type TableDraft
} from "./row-edit";

const TABLE_NAME =
    "A table name starts with a letter or an underscore and holds only letters, digits and underscores.";

const name = z.string().min(1).max(256);
const namespace = z.string().max(256).nullable();

export const rowInsertSchema = z.object({
    namespace,
    relation: name,
    values: z
        .record(name, z.string().max(1_000_000).nullable())
        .refine((values) => Object.keys(values).length <= 1000, "That is too long.")
});

export const rowDeleteSchema = z.object({
    namespace,
    relation: name,
    keys: z
        .array(z.record(name, z.unknown()))
        .min(1, "Pick the rows to remove.")
        .max(MAX_DELETE_ROWS, `Remove at most ${MAX_DELETE_ROWS} rows at a time from here.`)
});

const columnDefaultSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
        kind: z.literal("value"),
        value: z.string().max(200, "A default can be at most 200 characters.")
    }),
    z.object({ kind: z.literal("expression"), expression: z.enum(DEFAULT_EXPRESSIONS) })
]);

export const columnDraftSchema = z.object({
    name: z
        .string()
        .trim()
        .refine(
            isPlainIdentifier,
            "A column name starts with a letter or an underscore and holds only letters, digits and underscores."
        ),
    type: z.enum(TABLE_TYPES),
    nullable: z.boolean(),
    primaryKey: z.boolean(),
    unique: z.boolean(),
    defaultValue: columnDefaultSchema
});

export const tableDraftSchema = z
    .object({
        namespace,
        name: z.string().trim().refine(isPlainIdentifier, TABLE_NAME),
        columns: z
            .array(columnDraftSchema)
            .min(1, "Give the table at least one column.")
            .max(MAX_NEW_COLUMNS, `A table made here can have at most ${MAX_NEW_COLUMNS} columns.`)
    })
    .superRefine((draft, context) => {
        const seen = new Set<string>();
        draft.columns.forEach((column, index) => {
            const folded = column.name.toLowerCase();
            if (folded && seen.has(folded)) {
                context.addIssue({
                    code: "custom",
                    path: ["columns", index, "name"],
                    message: `There are two columns called ${column.name}.`
                });
            }
            seen.add(folded);
        });
    });

/** The draft as the schema hands it back: names trimmed. */
export function parseTableDraft(input: unknown): z.SafeParseReturnType<unknown, TableDraft> {
    return tableDraftSchema.safeParse(input) as z.SafeParseReturnType<unknown, TableDraft>;
}
