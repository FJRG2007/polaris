"use server";

/**
 * Writes to notes, their folders and the shelves both sit on.
 *
 * Every one of these does the same three things in the same order: resolve the
 * caller and the instance permission, ask `lib/notes/access.ts` whether they may
 * touch this row, then validate the shape. Authorization first, because a schema
 * error on a note somebody cannot reach would still tell them the note exists.
 *
 * Refusals are returned, never thrown. A thrown server action replaces the
 * screen with an error page, and none of these is worth losing what somebody had
 * open - so the sentence comes back and the caller shows it where it happened.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as access from "@/lib/notes/access";
import { requirePermission } from "@/lib/session";
import * as notes from "@/lib/notes/note-service";
import * as shelves from "@/lib/notes/shelf-service";
import { importVault } from "@/lib/notes/import-service";
import { findPeople } from "@/lib/people-search";
import { listAdministeredOrgs } from "@/lib/orgs/org-service";

const NOTES_PATH = "/notes";
const ARCHIVE_PATH = "/notes/archive";

/** The caller, once the instance permission has been checked. */
async function actor(): Promise<access.NoteActor> {
    const user = await requirePermission("notes.use");
    return { id: user.id, isAdmin: user.isAdmin };
}

/** What a refusal from the access layer looks like on the way out. Anything else
 *  is a fault rather than an answer, and is not described to the reader. */
function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof access.NoteAccessError) return { error: caught.message };
    console.error("polaris: a note action failed:", caught);
    return { error: fallback };
}

function refresh(): void {
    revalidatePath(NOTES_PATH);
    revalidatePath(ARCHIVE_PATH);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function createNoteAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.noteCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That note could not be saved" };

    try {
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId ?? null,
            folderId: parsed.data.folderId ?? null
        });
        const id = await notes.createNote(caller.id, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That note could not be saved");
    }
}

export async function updateNoteAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That note could not be saved" };

    try {
        await access.requireNote(caller, parsed.data.noteId, "member");
        if (!(await notes.updateNote(parsed.data))) return { error: "That note no longer exists" };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That note could not be saved");
    }
}

export async function moveNoteAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteMoveSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That note could not be moved" };

    try {
        // Both ends: the note as it is now, and the shelf it is going to.
        await access.requireNote(caller, parsed.data.noteId, "member");
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId,
            folderId: parsed.data.folderId
        });
        const refusal = await notes.moveNote(caller.id, parsed.data);
        if (refusal) return { error: refusal };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That note could not be moved");
    }
}

export async function deleteNoteAction(noteId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireNote(caller, noteId, "member");
        if (!(await notes.deleteNote(noteId))) return { error: "That note no longer exists" };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That note could not be deleted");
    }
}

// ---------------------------------------------------------------------------
// Shelves
// ---------------------------------------------------------------------------

/** The organizations this account may put a notebook on. Empty is the common
 *  answer and is what hides the picker rather than showing an empty one. */
export async function noteSpaceOwnersAction(): Promise<{ id: string; name: string }[]> {
    const caller = await actor();
    return listAdministeredOrgs(caller);
}

export async function createSpaceAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That notebook could not be made" };

    try {
        if (parsed.data.orgId) {
            // Belonging to an organization does not let somebody put work on its
            // shelf; running its spaces does.
            const allowed = await listAdministeredOrgs(caller);
            if (!allowed.some((org) => org.id === parsed.data.orgId)) {
                return { error: "You cannot make a notebook for that organization" };
            }
        }
        const id = await shelves.createSpace(caller, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That notebook could not be made");
    }
}

export async function updateSpaceAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That notebook could not be changed" };

    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        await shelves.updateSpace(parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That notebook could not be changed");
    }
}

/** What a notebook holds, so the delete dialog can say it before it is agreed
 *  to. Reading it is an admin's question about their own shelf. */
export async function spaceContentsAction(
    spaceId: string
): Promise<{ notes: number; folders: number; error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        return { ...(await shelves.spaceContents(spaceId)) };
    } catch (caught) {
        return { notes: 0, folders: 0, ...failure(caught, "That notebook could not be read") };
    }
}

export async function deleteSpaceAction(spaceId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        // Deleting takes the writing with it, so it is the owner's alone - an
        // admin of a shelf may run it without being able to end it.
        const role = await access.requireSpace(caller, spaceId, "admin");
        if (role !== "owner") return { error: "Only the notebook's owner can delete it" };
        await shelves.deleteSpace(spaceId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That notebook could not be deleted");
    }
}

// ---------------------------------------------------------------------------
// Who is on a shelf
// ---------------------------------------------------------------------------

export async function spaceAccessAction(spaceId: string): Promise<{
    people?: shelves.ShelfPerson[];
    teams?: shelves.ShelfTeam[];
    eligibleTeams?: { id: string; name: string }[];
    error?: string;
}> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        const [people, teams, eligibleTeams] = await Promise.all([
            shelves.spacePeople(spaceId),
            shelves.spaceTeams(spaceId),
            shelves.teamsForSpace(spaceId)
        ]);
        return { people, teams, eligibleTeams };
    } catch (caught) {
        return failure(caught, "Who can reach this notebook could not be read");
    }
}

export async function grantSpaceAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceGrantSchema.safeParse(input);
    if (!parsed.success) return { error: "That could not be granted" };

    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        if (parsed.data.teamId) {
            // Both ends are checked: an admin of this shelf, and a team that is
            // actually part of the organization the shelf belongs to.
            const eligible = await shelves.teamsForSpace(parsed.data.spaceId);
            if (!eligible.some((team) => team.id === parsed.data.teamId)) {
                return { error: "That team is not part of the organization this notebook belongs to" };
            }
            await shelves.grantTeam(parsed.data.spaceId, parsed.data.teamId, parsed.data.role);
        } else if (parsed.data.userId) {
            await shelves.grantPerson(parsed.data.spaceId, parsed.data.userId, parsed.data.role);
        } else {
            return { error: "Say who this is for" };
        }
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That could not be granted");
    }
}

export async function revokeSpaceAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceGrantSchema.safeParse(input);
    if (!parsed.success) return { error: "That could not be taken back" };

    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        if (parsed.data.teamId) await shelves.revokeTeam(parsed.data.spaceId, parsed.data.teamId);
        else if (parsed.data.userId) await shelves.revokePerson(parsed.data.spaceId, parsed.data.userId);
        else return { error: "Say who this is for" };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That could not be taken back");
    }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolderAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.noteFolderCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That folder could not be made" };

    try {
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId,
            folderId: parsed.data.parentId
        });
        const id = await shelves.createFolder(caller, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "That folder could not be made");
    }
}

export async function updateFolderAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteFolderUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That folder could not be changed" };

    try {
        await access.requireFolder(caller, parsed.data.folderId, "member");
        await shelves.updateFolder(parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That folder could not be changed");
    }
}

export async function moveFolderAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteFolderMoveSchema.safeParse(input);
    if (!parsed.success) return { error: "That folder could not be moved" };

    try {
        await access.requireFolder(caller, parsed.data.folderId, "member");
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId,
            folderId: parsed.data.parentId
        });
        const refusal = await shelves.moveFolder(caller, parsed.data);
        if (refusal) return { error: refusal };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That folder could not be moved");
    }
}

export async function folderContentsAction(
    folderId: string
): Promise<{ notes: number; folders: number; error?: string }> {
    const caller = await actor();
    try {
        await access.requireFolder(caller, folderId, "member");
        return { ...(await shelves.folderContents(folderId)) };
    } catch (caught) {
        return { notes: 0, folders: 0, ...failure(caught, "That folder could not be read") };
    }
}

export async function deleteFolderAction(folderId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireFolder(caller, folderId, "member");
        await shelves.deleteFolder(folderId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "That folder could not be deleted");
    }
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** How much one import may weigh. A vault of Markdown is small; anything past
 *  this is a vault with its attachments still in it, which is not what this
 *  reads. */
const IMPORT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Read Markdown files, or a zipped vault, onto a shelf.
 *
 * A FormData rather than a JSON argument because the files come from a file
 * input, and the browser has them as blobs. The zip is unpacked here rather than
 * in the browser so the paths inside it are read once, by the same code that
 * builds the plan from a set of loose files.
 */
export async function importNotesAction(form: FormData): Promise<{
    notes?: number;
    folders?: number;
    links?: number;
    skipped?: readonly core.SkippedFile[];
    error?: string;
}> {
    const caller = await actor();
    const parsed = core.noteImportSchema.safeParse({
        spaceId: form.get("spaceId") || null,
        folderId: form.get("folderId") || null,
        keepFolders: form.get("keepFolders") !== "false"
    });
    if (!parsed.success) return { error: "That import could not be read" };

    const uploaded = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (uploaded.length === 0) return { error: "Choose the files to bring in" };
    const weight = uploaded.reduce((total, file) => total + file.size, 0);
    if (weight > IMPORT_MAX_BYTES) {
        return { error: "That is more than one import can carry. Bring it in a few at a time." };
    }

    try {
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId,
            folderId: parsed.data.folderId
        });
        const files = await readUploads(uploaded);
        if (files.length === 0) return { error: "There was nothing to read in those files" };
        const result = await importVault(caller.id, parsed.data, files);
        refresh();
        return result;
    } catch (caught) {
        return failure(caught, "That import could not be finished");
    }
}

/**
 * The files an import will actually read.
 *
 * A zip is unpacked and its entries take the paths they had inside it; anything
 * else is read as one file at the name the browser gave it, which for a folder
 * upload is already the path inside the folder.
 */
async function readUploads(uploaded: readonly File[]): Promise<core.ImportFile[]> {
    const files: core.ImportFile[] = [];
    for (const file of uploaded) {
        const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        if (/\.zip$/i.test(file.name)) {
            const JSZip = (await import("jszip")).default;
            const zip = await JSZip.loadAsync(await file.arrayBuffer());
            for (const entry of Object.values(zip.files)) {
                if (entry.dir || !core.isImportable(entry.name)) continue;
                files.push({ path: entry.name, text: await entry.async("string") });
            }
            continue;
        }
        if (!core.isImportable(name)) continue;
        files.push({ path: name, text: await file.text() });
    }
    return files;
}

/**
 * Who this account may put on a notebook.
 *
 * Its own action rather than Chat's, for the reason the privacy screen learned
 * the hard way: Chat's first act is to check `chat.use`, so an account without
 * the chat would be redirected away from its own notebook the moment the picker
 * mounted. Sharing a notebook is not a chat feature.
 */
export async function searchNotePeopleAction(
    query: string
): Promise<{ results?: { id: string; name: string }[] }> {
    const user = await requirePermission("notes.use");
    const found = await findPeople(user, String(query ?? ""), { reachableOnly: false });
    return { results: found.people };
}
