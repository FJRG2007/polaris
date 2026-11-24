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

import { z } from "zod";
import * as core from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { revalidatePath } from "next/cache";
import * as access from "@/lib/notes/access";
import { dropGrantsFor } from "@/lib/access/grants";
import { requirePermission } from "@/lib/session";
import * as notes from "@/lib/notes/note-service";
import * as shelves from "@/lib/notes/shelf-service";
import { importVault } from "@/lib/notes/import-service";
import { findPeople } from "@/lib/people-search";
import { listAdministeredOrgs } from "@/lib/orgs/org-service";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import * as share from "@/lib/notes/share-service";
import * as templates from "@/lib/notes/template-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";

const NOTES_PATH = "/notes";
const ARCHIVE_PATH = "/notes/archive";
/** `noteTitle` in core: a conflict copy's longer title is cut to fit it. */
const NOTE_TITLE_MAX = 200;

/** Guesses at one link's password, per address, per window. Low, because the
 *  password on a public link is the only thing standing in front of it. */
const UNLOCK_LIMIT = 8;
const UNLOCK_WINDOW_MS = 10 * 60_000;

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
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.noteSave")
        };

    try {
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId ?? null,
            folderId: parsed.data.folderId ?? null
        });
        const start = parsed.data.templateId
            ? await templates.templateForPlacement(
                  caller,
                  parsed.data.templateId,
                  parsed.data.spaceId ?? null
              )
            : null;
        const id = await notes.createNote(caller.id, { ...parsed.data, ...start });
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.noteSave"));
    }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function templateFromNoteAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const t = await getTranslations("notes");
    const parsed = core.noteTemplateFromNoteSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t("errors.templateSave") };
    try {
        const id = await templates.templateFromNote(caller, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, t("errors.templateSave"));
    }
}

/** At most this many templates are asked for at once: every shelf's, for the
 *  most shelves a reader is likely to have open. */
const TEMPLATE_CONTENTS_MAX = 500;

/** The title and text of templates, for this device to keep so a note can start
 *  from one while Polaris cannot be reached. */
export async function templateContentsAction(ids: unknown): Promise<templates.NoteTemplateContent[]> {
    const caller = await actor();
    const parsed = z.array(core.noteTemplateUpdateSchema.shape.templateId).max(TEMPLATE_CONTENTS_MAX).safeParse(ids);
    if (!parsed.success) return [];
    return templates.templateContents(caller, [...new Set(parsed.data)]);
}

export async function updateTemplateAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const t = await getTranslations("notes");
    const parsed = core.noteTemplateUpdateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t("errors.templateSave") };
    try {
        await templates.updateTemplate(caller, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, t("errors.templateSave"));
    }
}

export async function deleteTemplateAction(templateId: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const t = await getTranslations("notes");
    const parsed = core.noteTemplateUpdateSchema.shape.templateId.safeParse(templateId);
    if (!parsed.success) return { error: t("errors.templateSave") };
    try {
        await templates.deleteTemplate(caller, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, t("errors.templateSave"));
    }
}

export async function updateNoteAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteUpdateSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.noteSave")
        };

    try {
        await access
            .requireNote(caller, parsed.data.noteId, "member")
            .catch(async (refused: unknown) => {
                // A note shared to edit on its own: its title and text, nothing else.
                const textOnly = Object.keys(parsed.data).every((key) =>
                    ["noteId", "title", "body"].includes(key)
                );
                if (!textOnly || (await access.sharedNote(caller, parsed.data.noteId)) !== "edit")
                    throw refused;
            });
        if (!(await notes.updateNote(parsed.data)))
            return { error: (await getTranslations("notes"))("errors.noteGone") };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.noteSave"));
    }
}

const noteTextSaveSchema = z.object({
    noteId: core.noteUpdateSchema.shape.noteId,
    title: core.noteUpdateSchema.shape.title.unwrap(),
    body: core.noteUpdateSchema.shape.body.unwrap(),
    /** The note's version the device last saw; null writes regardless. */
    baseUpdatedAt: z.string().datetime().nullable(),
    /** The device's write key: the id of the copy kept on a conflict. */
    copyId: z.string().uuid()
});

/**
 * The autosave, live or replayed from this device's offline queue
 * (`notes/offline-writes`). Answers the note's new version; on an edit made
 * elsewhere since `baseUpdatedAt`, leaves that edit alone and keeps the device's
 * text as a note of its own beside it (`copyId`), or `conflict` where the reader
 * cannot add notes there.
 */
export async function saveNoteTextAction(
    input: unknown
): Promise<{ updatedAt?: string; copyId?: string; conflict?: true; error?: string }> {
    const caller = await actor();
    const t = await getTranslations("notes");
    const parsed = noteTextSaveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t("errors.noteSave") };
    const { noteId, title, body, baseUpdatedAt, copyId } = parsed.data;

    try {
        await access.requireNote(caller, noteId, "member").catch(async (refused: unknown) => {
            if ((await access.sharedNote(caller, noteId)) !== "edit") throw refused;
        });
        const saved = await notes.saveNoteText(
            { noteId, title, body },
            baseUpdatedAt ? new Date(baseUpdatedAt) : null
        );
        if (!saved) return { error: t("errors.noteGone") };
        if ("updatedAt" in saved) {
            refresh();
            return { updatedAt: saved.updatedAt.toISOString() };
        }
        const placed = await access
            .requirePlacement(caller, { spaceId: saved.stale.spaceId, folderId: saved.stale.folderId })
            .then(
                () => true,
                () => false
            );
        if (!placed) return { conflict: true };
        const kept = await notes.keepConflictCopy(caller.id, copyId, saved.stale, {
            title: t("offline.conflictTitle", { title }).slice(0, NOTE_TITLE_MAX),
            body
        });
        refresh();
        return { copyId: kept };
    } catch (caught) {
        return failure(caught, t("errors.noteSave"));
    }
}

export async function moveNoteAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteMoveSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.noteMove")
        };

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
        return failure(caught, (await getTranslations("notes"))("errors.noteMove"));
    }
}

export async function deleteNoteAction(noteId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        // Already gone is what was asked for: a delete kept offline and sent
        // again after a lost answer, or one somebody else got to first.
        if (!(await notes.noteExists(noteId))) return {};
        await access.requireNote(caller, noteId, "member");
        if (!(await notes.deleteNote(noteId))) return {};
        await dropGrantsFor("note.note", noteId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.noteDelete"));
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
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.notebookMake")
        };

    try {
        if (parsed.data.orgId) {
            // Belonging to an organization does not let somebody put work on its
            // shelf; running its spaces does.
            const allowed = await listAdministeredOrgs(caller);
            if (!allowed.some((org) => org.id === parsed.data.orgId)) {
                return { error: (await getTranslations("notes"))("errors.notebookOrg") };
            }
        }
        const id = await shelves.createSpace(caller, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.notebookMake"));
    }
}

export async function updateSpaceAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceUpdateSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.notebookChange")
        };

    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        await shelves.updateSpace(parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.notebookChange"));
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
        return {
            notes: 0,
            folders: 0,
            ...failure(caught, (await getTranslations("notes"))("errors.notebookRead"))
        };
    }
}

export async function deleteSpaceAction(spaceId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        // Deleting takes the writing with it, so it is the owner's alone - an
        // admin of a shelf may run it without being able to end it.
        const role = await access.requireSpace(caller, spaceId, "admin");
        if (role !== "owner")
            return { error: (await getTranslations("notes"))("errors.notebookOwner") };
        await shelves.deleteSpace(spaceId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.notebookDelete"));
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
            shelves.spacePeople(spaceId, caller),
            shelves.spaceTeams(spaceId),
            shelves.teamsForSpace(spaceId)
        ]);
        return { people, teams, eligibleTeams };
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.peopleRead"));
    }
}

export async function grantSpaceAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceGrantSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("notes"))("errors.grant") };

    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        if (parsed.data.teamId) {
            // Both ends are checked: an admin of this shelf, and a team that is
            // actually part of the organization the shelf belongs to.
            const eligible = await shelves.teamsForSpace(parsed.data.spaceId);
            if (!eligible.some((team) => team.id === parsed.data.teamId)) {
                return {
                    error: (await getTranslations("notes"))("errors.teamOutside")
                };
            }
            await shelves.grantTeam(parsed.data.spaceId, parsed.data.teamId, parsed.data.role);
        } else if (parsed.data.userId) {
            await shelves.grantPerson(parsed.data.spaceId, parsed.data.userId, parsed.data.role);
        } else {
            return { error: (await getTranslations("notes"))("errors.whoFor") };
        }
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.grant"));
    }
}

export async function revokeSpaceAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteSpaceGrantSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("notes"))("errors.revoke") };

    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        if (parsed.data.teamId) await shelves.revokeTeam(parsed.data.spaceId, parsed.data.teamId);
        else if (parsed.data.userId)
            await shelves.revokePerson(parsed.data.spaceId, parsed.data.userId);
        else return { error: (await getTranslations("notes"))("errors.whoFor") };
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.revoke"));
    }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolderAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.noteFolderCreateSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.folderMake")
        };

    try {
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId,
            folderId: parsed.data.parentId
        });
        const id = await shelves.createFolder(caller, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.folderMake"));
    }
}

export async function updateFolderAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteFolderUpdateSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.folderChange")
        };

    try {
        await access.requireFolder(caller, parsed.data.folderId, "member");
        await shelves.updateFolder(parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.folderChange"));
    }
}

export async function moveFolderAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.noteFolderMoveSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("notes"))("errors.folderMove") };

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
        return failure(caught, (await getTranslations("notes"))("errors.folderMove"));
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
        return {
            notes: 0,
            folders: 0,
            ...failure(caught, (await getTranslations("notes"))("errors.folderRead"))
        };
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
        return failure(caught, (await getTranslations("notes"))("errors.folderDelete"));
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
    if (!parsed.success) return { error: (await getTranslations("notes"))("errors.importRead") };

    const uploaded = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (uploaded.length === 0)
        return { error: (await getTranslations("notes"))("errors.importChoose") };
    const weight = uploaded.reduce((total, file) => total + file.size, 0);
    if (weight > IMPORT_MAX_BYTES) {
        return { error: (await getTranslations("notes"))("errors.importTooBig") };
    }

    try {
        await access.requirePlacement(caller, {
            spaceId: parsed.data.spaceId,
            folderId: parsed.data.folderId
        });
        const files = await readUploads(uploaded);
        if (files.length === 0)
            return { error: (await getTranslations("notes"))("errors.importEmpty") };
        const result = await importVault(caller.id, parsed.data, files);
        refresh();
        return result;
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.importFinish"));
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
        const name =
            (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
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
// ---------------------------------------------------------------------------
// Publishing a note
// ---------------------------------------------------------------------------

/** The link on a note, for the dialog that opens over it. */
export async function noteShareAction(
    noteId: string
): Promise<{ share?: share.NoteShareView | null; error?: string }> {
    const caller = await actor();
    try {
        return { share: await share.getNoteShare(caller, noteId) };
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.linkRead"));
    }
}

/**
 * Publish a note, or change how it is published.
 *
 * The URL comes back every time rather than only on the first call: the dialog
 * shows it, and a screen that had to ask for it separately after every change is
 * a screen where the address on it is sometimes the old one.
 */
export async function publishNoteAction(
    noteId: string,
    input: unknown
): Promise<{ url?: string; share?: share.NoteShareView; error?: string }> {
    const caller = await actor();
    const parsed = core.noteShareSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("notes"))("errors.settingsRead")
        };
    }
    try {
        const published = await share.publishNote(caller, noteId, parsed.data);
        refresh();
        return published;
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.notePublish"));
    }
}

/** The link again, for somebody who closed the dialog. */
export async function revealNoteShareAction(
    noteId: string
): Promise<{ url?: string; error?: string }> {
    const caller = await actor();
    try {
        return { url: await share.revealNoteShare(caller, noteId) };
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.linkShow"));
    }
}

/** Take it down. What goes back up later is a new address, which is the honest
 *  behaviour: a link that was revoked and restored is not the same link. */
export async function unpublishNoteAction(noteId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await share.unpublishNote(caller, noteId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, (await getTranslations("notes"))("errors.linkDown"));
    }
}

/**
 * The password on a published note, checked from the public page.
 *
 * Not behind `notes.use` and not behind a session: the whole point is that the
 * person solving it has no account. What stands in for one is the token they
 * already hold, a limit per link per address, and a cookie that says nothing but
 * "this link was opened".
 */
export async function unlockNoteShareAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const link = await share.resolveNoteShareByToken(token);
    if (!link) return { error: (await getTranslations("notes"))("errors.linkUnavailable") };
    if (!share.noteShareUsability(link).ok)
        return { error: (await getTranslations("notes"))("errors.linkGone") };

    const limitKey = `note-unlock:${link.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: (await getTranslations("notes"))("errors.tooManyAttempts") };
    }
    if (!(await share.verifyNoteSharePassword(link.id, password))) {
        return { error: (await getTranslations("notes"))("errors.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    (await cookies()).set(
        share.noteUnlockCookie(link.id),
        share.signNoteUnlock(link.id, link.passwordHash, env.POLARIS_AUTH_SECRET),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: 60 * 60 * 12
        }
    );
    return {};
}
