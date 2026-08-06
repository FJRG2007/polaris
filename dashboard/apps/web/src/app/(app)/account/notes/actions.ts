"use server";

/**
 * Writes to somebody's own notes.
 *
 * There is no permission check beyond being signed in, and no space role, because
 * a note has no audience: every query in the service is filtered by the caller's
 * own id, so the account is the authorization. What these add on top is the
 * schema - a hand-made request cannot store a title of forty thousand characters
 * or a body the editor could never have produced.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import * as notes from "@/lib/notes/note-service";

const NOTES_PATH = "/account/notes";

export async function createNoteAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const user = await requireUser();
    const parsed = core.noteCreateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That note could not be saved" };

    const id = await notes.createNote(user.id, parsed.data);
    revalidatePath(NOTES_PATH);
    return { id };
}

export async function updateNoteAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = core.noteUpdateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That note could not be saved" };

    const saved = await notes.updateNote(user.id, parsed.data);
    if (!saved) return { error: "That note no longer exists" };
    revalidatePath(NOTES_PATH);
    return {};
}

export async function deleteNoteAction(noteId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    if (!(await notes.deleteNote(user.id, noteId))) return { error: "That note no longer exists" };
    revalidatePath(NOTES_PATH);
    return {};
}
