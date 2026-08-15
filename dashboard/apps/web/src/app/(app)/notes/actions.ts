"use server";

/**
 * Writes to somebody's own notes.
 *
 * There is no permission check beyond holding `notes.use`, and no space role,
 * because a note has no audience: every query in the service is filtered by the
 * caller's own id, so the account is the authorization. What these add on top is
 * the schema - a hand-made request cannot store a title of forty thousand
 * characters or a body the editor could never have produced.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import * as notes from "@/lib/notes/note-service";

const NOTES_PATH = "/notes";
const ARCHIVE_PATH = "/notes/archive";

export async function createNoteAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const user = await requirePermission("notes.use");
    const parsed = core.noteCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That note could not be saved" };

    const id = await notes.createNote(user.id, parsed.data);
    revalidatePath(NOTES_PATH);
    return { id };
}

export async function updateNoteAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("notes.use");
    const parsed = core.noteUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That note could not be saved" };

    const saved = await notes.updateNote(user.id, parsed.data);
    if (!saved) return { error: "That note no longer exists" };
    revalidatePath(NOTES_PATH);
    // Archiving and restoring both move a note between the two screens, so both
    // are stale after either.
    revalidatePath(ARCHIVE_PATH);
    return {};
}

export async function moveNoteAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("notes.use");
    const parsed = core.noteMoveSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That note could not be moved" };

    const refusal = await notes.moveNote(user.id, parsed.data);
    if (refusal) return { error: refusal };
    revalidatePath(NOTES_PATH);
    return {};
}

export async function deleteNoteAction(noteId: string): Promise<{ error?: string }> {
    const user = await requirePermission("notes.use");
    if (!(await notes.deleteNote(user.id, noteId))) return { error: "That note no longer exists" };
    revalidatePath(NOTES_PATH);
    revalidatePath(ARCHIVE_PATH);
    return {};
}
