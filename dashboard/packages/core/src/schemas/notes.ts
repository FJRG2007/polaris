/**
 * Notes: what somebody writes down for themselves.
 *
 * Deliberately its own contract rather than a variation of a task or a page.
 * A note has no state, no owner other than its author and nobody to share it
 * with, and every one of those absences is the feature. The text is the same
 * Markdown everything else in Polaris is written in, so anything here can be
 * pasted into a task or a page and keeps its mentions.
 *
 * The one structure it does have is nesting, because thirty notes in a flat list
 * is a filing problem and the shape people reach for is a notebook's: a few
 * subjects with pages under each. Any note can hold others - there is no second
 * kind of thing to create.
 */

import { z } from "zod";

export const noteTitle = z.string().trim().min(1, "Give it a title").max(200);

/** The same ceiling a page has: long enough for anything somebody types by
 *  hand, low enough that a paste cannot be used to fill the database. */
export const noteBody = z.string().max(200000);

/** How deep the tree may go. Not a storage limit - it is what a sidebar can
 *  indent and a person can still hold in their head, and past it the answer is
 *  a different note rather than another level. */
export const NOTE_MAX_DEPTH = 5;

export const noteCreateSchema = z.object({
    title: noteTitle.default("Untitled"),
    body: noteBody.default(""),
    /** The note this one goes under. Null, or absent, means the top level. */
    parentId: z.string().uuid().nullable().optional()
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

/**
 * Moving a note somewhere else in the tree.
 *
 * Its own contract rather than a field on the update above, because it is the
 * one edit that can fail on grounds the text never can: a note cannot go under
 * itself, under one of its own descendants, or so deep that the sidebar runs
 * out of room. Those are checked against the stored tree, so they live in the
 * service - what this settles is only the shape.
 */
export const noteMoveSchema = z.object({
    noteId: z.string().uuid(),
    parentId: z.string().uuid().nullable()
});

export type NoteMoveInput = z.infer<typeof noteMoveSchema>;
