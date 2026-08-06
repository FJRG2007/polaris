/**
 * Notes: what somebody writes down for themselves.
 *
 * Deliberately its own contract rather than a variation of a task or a page.
 * A note has no state, no owner other than its author, no place in a hierarchy
 * and nobody to share it with, and every one of those absences is the feature.
 * The text is the same Markdown everything else in Polaris is written in, so
 * anything here can be pasted into a task or a page and keeps its mentions.
 */

import { z } from "zod";

export const noteTitle = z.string().trim().min(1, "Give it a title").max(200);

/** The same ceiling a page has: long enough for anything somebody types by
 *  hand, low enough that a paste cannot be used to fill the database. */
export const noteBody = z.string().max(200000);

export const noteCreateSchema = z.object({
    title: noteTitle.default("Untitled"),
    body: noteBody.default("")
});

export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = z.object({
    noteId: z.string().uuid(),
    title: noteTitle.optional(),
    body: noteBody.optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
});

export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;
