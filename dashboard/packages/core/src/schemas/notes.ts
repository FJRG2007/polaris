/**
 * Notes: what somebody writes down, on their own or with the people they work
 * with.
 *
 * The text is the same Markdown everything else in Polaris is written in, so
 * anything here can be pasted into a task or a page and keeps its mentions.
 *
 * Two structures, and they are not the same idea twice.
 *
 * **A note holds notes.** A page with pages under it is what a wiki is, and it
 * is what thirty notes in a flat list turn into the moment somebody has to find
 * one. Any note can hold others; there is no second thing to create for it.
 *
 * **A folder holds anything.** It is the shape a vault of Markdown already has
 * on disk, and somebody arriving with one has thousands of files arranged in
 * exactly that. Flattening a folder into a note would throw away a distinction
 * its author made, so both exist and each keeps its own meaning: a folder is
 * where things are filed, a parent note is what they are part of.
 *
 * **A space is a shelf.** Without one a note is what it has always been -
 * private without qualification, readable by its author and nobody else. With
 * one it belongs to a group, reached exactly the way a Tasks space is: a
 * membership, a team grant, or the organization that owns it. The vocabulary is
 * literally the same one, imported rather than restated, so a role means one
 * thing across Polaris.
 */

import { z } from "zod";
import { FOLDER_DEPTH_LIMIT, hexColor, SPACE_ROLES, SPACE_VISIBILITIES } from "./tasks.js";

export const noteTitle = z.string().trim().min(1, "Give it a title").max(200);

/** The same ceiling a page has: long enough for anything somebody types by
 *  hand, low enough that a paste cannot be used to fill the database. */
export const noteBody = z.string().max(200000);

/** How deep notes may nest inside each other. Not a storage limit - it is what a
 *  sidebar can indent and a person can still hold in their head, and past it the
 *  answer is a different note rather than another level. */
export const NOTE_MAX_DEPTH = 5;

/** How deep folders may nest. Higher than the note tree because this one mirrors
 *  a directory somebody already has, and a real vault is filed deeper than a
 *  page is nested. Literally the Tasks limit rather than a copy of its value:
 *  `folderMoveRefusal` is what refuses a drag in both apps, and it measures
 *  against that one - a second number here would be a limit the screen states
 *  and the server does not enforce. */
export const NOTE_FOLDER_MAX_DEPTH = FOLDER_DEPTH_LIMIT;

/** One emoji, or nothing. Long enough for the ones written as a pair of code
 *  points with a joiner between them, short enough that it is not a label. */
export const noteIcon = z.string().trim().min(1).max(8).nullable().optional();

const uuid = z.string().uuid();

/** Where something is filed: which shelf, and which folder on it. Null on both
 *  is the top of somebody's own private shelf, which is where a note made from
 *  the New note button lands. */
export const noteShelfSchema = z.object({
    spaceId: uuid.nullable().default(null),
    folderId: uuid.nullable().default(null)
});

export type NoteShelf = z.infer<typeof noteShelfSchema>;

export const noteCreateSchema = z.object({
    title: noteTitle.default("Untitled"),
    body: noteBody.default(""),
    /** The note this one goes under. Null, or absent, means the top level. */
    parentId: uuid.nullable().optional(),
    spaceId: uuid.nullable().optional(),
    folderId: uuid.nullable().optional()
});

export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = z.object({
    noteId: uuid,
    title: noteTitle.optional(),
    body: noteBody.optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
});

export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;

/**
 * Moving a note.
 *
 * Its own contract rather than a field on the update above, because it is the
 * one edit that can fail on grounds the text never can: a note cannot go under
 * itself, under one of its own descendants, so deep that the sidebar runs out of
 * room, or onto a shelf its mover cannot reach. Those are checked against what
 * is stored, so they live in the service - what this settles is only the shape.
 *
 * All three destinations are sent together because they move together: dragging
 * a note into a folder on another shelf is one gesture, and an update that took
 * them one at a time would leave it briefly filed somewhere it does not belong.
 */
export const noteMoveSchema = z.object({
    noteId: uuid,
    parentId: uuid.nullable(),
    spaceId: uuid.nullable().default(null),
    folderId: uuid.nullable().default(null)
});

export type NoteMoveInput = z.infer<typeof noteMoveSchema>;

// ---------------------------------------------------------------------------
// Shelves
// ---------------------------------------------------------------------------

export const noteSpaceName = z.string().trim().min(1, "Give it a name").max(80);

export const noteSpaceCreateSchema = z.object({
    name: noteSpaceName,
    icon: noteIcon,
    color: hexColor.default("#7c5cff"),
    visibility: z.enum(SPACE_VISIBILITIES).default("private"),
    /** The organization it belongs to, or null for one of your own. Read only
     *  when the space is made: moving a shelf between a person and a group is a
     *  transfer, not an edit. */
    orgId: uuid.nullable().default(null)
});

export type NoteSpaceCreateInput = z.infer<typeof noteSpaceCreateSchema>;

export const noteSpaceUpdateSchema = z.object({
    spaceId: uuid,
    name: noteSpaceName.optional(),
    icon: noteIcon,
    color: hexColor.optional(),
    visibility: z.enum(SPACE_VISIBILITIES).optional(),
    archived: z.boolean().optional()
});

export type NoteSpaceUpdateInput = z.infer<typeof noteSpaceUpdateSchema>;

/** Putting somebody, or a whole team, on a shelf. One schema for both because
 *  the only difference is which id is named, and the role means the same thing
 *  either way. */
export const noteSpaceGrantSchema = z.object({
    spaceId: uuid,
    userId: uuid.optional(),
    teamId: uuid.optional(),
    role: z.enum(SPACE_ROLES).default("member")
});

export type NoteSpaceGrantInput = z.infer<typeof noteSpaceGrantSchema>;

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export const noteFolderName = z
    .string()
    .trim()
    .min(1, "Give it a name")
    .max(120)
    // The characters a folder cannot be named because a vault on disk cannot
    // name one that either, so a folder made here can always be written back out.
    .refine((name) => !/[\\/:*?"<>|]/.test(name), "A folder name cannot contain \\ / : * ? \" < > |");

export const noteFolderCreateSchema = z.object({
    name: noteFolderName,
    icon: noteIcon,
    spaceId: uuid.nullable().default(null),
    parentId: uuid.nullable().default(null)
});

export type NoteFolderCreateInput = z.infer<typeof noteFolderCreateSchema>;

export const noteFolderUpdateSchema = z.object({
    folderId: uuid,
    name: noteFolderName.optional(),
    icon: noteIcon,
    archived: z.boolean().optional()
});

export type NoteFolderUpdateInput = z.infer<typeof noteFolderUpdateSchema>;

export const noteFolderMoveSchema = z.object({
    folderId: uuid,
    spaceId: uuid.nullable().default(null),
    parentId: uuid.nullable().default(null)
});

export type NoteFolderMoveInput = z.infer<typeof noteFolderMoveSchema>;

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** How much of a vault one import may carry. A ceiling on the files rather than
 *  on the bytes: what makes an import expensive here is a row and a reference
 *  pass per file, not the size of any one of them. */
export const NOTE_IMPORT_MAX_FILES = 2000;

/** The extensions an import will read. Everything else in a vault - images,
 *  PDFs, the `.obsidian` folder - is left where it is and reported as skipped,
 *  rather than half-imported as text nobody can read. */
export const NOTE_IMPORT_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"] as const;

export const noteImportSchema = z.object({
    /** Where the whole import lands. Its folders are made underneath this. */
    spaceId: uuid.nullable().default(null),
    folderId: uuid.nullable().default(null),
    /** Whether the vault's own directories become folders. Off files everything
     *  flat, which is what somebody importing a handful of pages wants. */
    keepFolders: z.boolean().default(true)
});

export type NoteImportInput = z.infer<typeof noteImportSchema>;
