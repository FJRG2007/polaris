/**
 * Notes, as tools an agent can call.
 *
 * What somebody wrote down is the context an assistant is most often missing:
 * the meeting notes, the list of what is left, the draft. These read and write
 * them through the same two modules the Notes screen does - `lib/notes/access`
 * decides whether this account may touch a note, `lib/notes/note-service` does
 * the reading and writing - so a private note stays its writer's alone and a
 * notebook somebody cannot open is one their assistant cannot open either.
 *
 * Deliberately not offered: deleting a note, moving one between notebooks, and
 * publishing one as a link. Each is a click in the screen and none is something
 * an assistant should be doing on a guess.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { NoteActor } from "@/lib/notes/access";
import { moreLine, pageFields, pageOf } from "./paging";
import { defineMcpSearch, preferMatches } from "../search";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";

/**
 * The notes services, loaded when a tool runs rather than when the catalogue
 * does. Listing the tools - which every client does first, and which the
 * catalogue test does - should not have to start the session and audit layers
 * these reach.
 */
async function services() {
    const [access, notes, shelves] = await Promise.all([
        import("@/lib/notes/access"),
        import("@/lib/notes/note-service"),
        import("@/lib/notes/shelf-service")
    ]);
    return { access, notes, shelves };
}

/** How much of a note one read returns. Notes may be far longer than anything a
 *  model should take in at once; the rest is reachable in the screen. */
const BODY_LIMIT = 50_000;

function actorFor(caller: McpCaller): NoteActor {
    return { id: caller.userId, isAdmin: caller.isAdmin };
}

/**
 * Run a note operation, turning the access layer's refusal into one the model
 * reads. Its sentences ("That note no longer exists", "You cannot make that
 * change here") are written for whoever asked and name nothing internal.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        const { NoteAccessError } = await import("@/lib/notes/access");
        if (caught instanceof NoteAccessError) throw new McpRefusal(caught.message);
        throw caught;
    }
}

const noteId = z.string().uuid().describe("The note's id, as notes_list returned it.");

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listInput = z.object({
    query: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe(
            "Words for the note's title or opening line, in any language. The best matches come first; empty, or nothing matching, lists every note."
        ),
    notebook: z
        .string()
        .trim()
        .max(80)
        .default("")
        .describe(
            'Limit to one notebook, by name or id. "private" is your own notes. Empty is every notebook.'
        ),
    ...pageFields
});

/** A note as the list hands it on. */
interface NoteRow {
    readonly id: string;
    readonly title: string;
    readonly excerpt: string;
    readonly notebook: string;
}

/** Where a note search reads: the title, then the opening line, then the
 *  notebook it is in. */
const NOTE_FIELDS: readonly core.SearchField<NoteRow>[] = [
    { text: (note) => note.title, weight: 1 },
    { text: (note) => note.excerpt, weight: 0.6 },
    { text: (note) => note.notebook, weight: 0.4 }
];

/** The notes on these shelves, as the list and the search both hand them on. */
async function notesOn(
    caller: McpCaller,
    shelves: readonly { readonly space: { readonly id: string; readonly name: string } | null }[]
) {
    const { notes } = await services();
    const listed = await Promise.all(
        shelves.map(async (shelf) =>
            (
                await notes.listNotes({
                    userId: caller.userId,
                    spaceId: shelf.space?.id ?? null
                })
            ).map((note) => ({
                id: note.id,
                title: note.title,
                excerpt: note.excerpt,
                notebook: shelf.space?.name ?? "private",
                notebookId: shelf.space?.id ?? null,
                parentId: note.parentId,
                pinned: note.pinned,
                updatedAt: note.updatedAt
            }))
        )
    );
    return listed.flat();
}

const listNotesTool: McpTool<z.infer<typeof listInput>> = {
    name: "notes_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List notes",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Find notes this account can open, in its own private notebook and the shared ones. Returns titles and opening lines, not the text; use notes_get for that.",
    input: listInput,
    category: "productivity",
    scope: "notes.use",
    readOnly: true,
    async run(input, caller) {
        const { access, shelves: shelfService } = await services();
        const actor = actorFor(caller);
        const shelves = await shelfService.listShelves(actor, await access.visibleSpaceIds(actor));
        // Accents and case do not count: "reuniones" is the notebook "Reuniónes".
        const wanted = core.normalizeSearchText(input.notebook);
        const chosen = wanted
            ? shelves.filter((shelf) =>
                  shelf.space
                      ? shelf.space.id === input.notebook ||
                        core.normalizeSearchText(shelf.space.name) === wanted
                      : wanted === "private"
              )
            : shelves;
        if (wanted && chosen.length === 0) {
            // Named with the ones it can open, so a model picks one rather than
            // stopping at the refusal.
            const names = shelves.map((shelf) => shelf.space?.name ?? "private");
            throw new McpRefusal(
                `No notebook called "${input.notebook}" that this account can open. It can open: ${names.join(", ")}.`
            );
        }

        const listed = await notesOn(caller, chosen);
        const found = core.matchForModel(listed, input.query, NOTE_FIELDS, {
            one: "note",
            other: "notes"
        });
        const page = pageOf(found.items, input.offset, input.limit);
        if (page.items.length === 0)
            return { text: "No notes matched.", structured: { notes: [], nextOffset: null } };
        return {
            text:
                (found.note ? `${found.note}\n` : "") +
                page.items
                    .map((note) => `${note.id}  ${note.title}  [${note.notebook}]`)
                    .join("\n") +
                moreLine(page),
            structured: { notes: page.items, nextOffset: page.nextOffset, matched: found.matched }
        };
    }
};

const getInput = z.object({ noteId });

const getNoteTool: McpTool<z.infer<typeof getInput>> = {
    name: "notes_get",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a note",
    // i18n-ignore read by the calling model, not shown to a person
    description: "Read one note in full: its title and its text, in Markdown.",
    input: getInput,
    category: "productivity",
    scope: "notes.use",
    readOnly: true,
    async run(input, caller) {
        const { access, notes } = await services();
        await attempt(() => access.requireNote(actorFor(caller), input.noteId, "guest"));
        const note = await notes.getNote(input.noteId);
        if (!note) throw new McpRefusal("That note no longer exists, or is archived.");
        const truncated = note.body.length > BODY_LIMIT;
        const body = truncated ? note.body.slice(0, BODY_LIMIT) : note.body;
        return {
            text: `${note.title}\n\n${body || "(empty)"}${
                truncated ? `\n\n(cut at ${BODY_LIMIT} characters of ${note.body.length})` : ""
            }`,
            structured: {
                id: note.id,
                title: note.title,
                body,
                truncated,
                pinned: note.pinned,
                parentId: note.parentId,
                notebookId: note.spaceId,
                updatedAt: note.updatedAt
            }
        };
    }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const createInput = z.object({
    title: core.noteTitle.describe("The note's title."),
    body: core.noteBody.default("").describe("The text, in Markdown."),
    notebookId: z
        .string()
        .uuid()
        .nullable()
        .default(null)
        .describe("The shared notebook to write it in, by id. Null is your own private notebook."),
    parentId: z
        .string()
        .uuid()
        .nullable()
        .default(null)
        .describe("A note on the same notebook to put this one under. Null is the top level.")
});

const createNoteTool: McpTool<z.infer<typeof createInput>> = {
    name: "notes_create",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Write a note",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Write a new note, in your private notebook unless a shared one is named. Returns its id.",
    input: createInput,
    category: "productivity",
    scope: "notes.use",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const { access, notes } = await services();
        const parsed = core.noteCreateSchema.parse({
            title: input.title,
            body: input.body,
            parentId: input.parentId,
            spaceId: input.notebookId,
            folderId: null
        });
        // The same check the screen makes before it creates anything: a
        // notebook this account may write in, or its own.
        await attempt(() =>
            access.requirePlacement(actorFor(caller), { spaceId: input.notebookId, folderId: null })
        );
        const id = await notes.createNote(caller.userId, parsed);
        return { text: `Created ${id}.`, structured: { id } };
    }
};

const updateInput = z
    .object({
        noteId,
        title: core.noteTitle.optional().describe("A new title."),
        body: core.noteBody
            .optional()
            .describe(
                "The whole new text, in Markdown. Replaces what is there; read it first with notes_get."
            ),
        pinned: z.boolean().optional().describe("Keep it at the top of its notebook.")
    })
    .refine(
        (value) =>
            value.title !== undefined || value.body !== undefined || value.pinned !== undefined,
        // i18n-ignore read by the calling model, not shown to a person
        { message: "Send at least one of title, body or pinned" }
    );

const updateNoteTool: McpTool<z.infer<typeof updateInput>> = {
    name: "notes_update",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Change a note",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Change a note's title, text or pin. Only the fields you send are written, and a new body replaces the old one whole.",
    input: updateInput,
    category: "productivity",
    scope: "notes.use",
    readOnly: false,
    idempotent: true,
    async run(input, caller) {
        const { access, notes } = await services();
        await attempt(() => access.requireNote(actorFor(caller), input.noteId, "member"));
        const written = await notes.updateNote(
            core.noteUpdateSchema.parse({
                noteId: input.noteId,
                title: input.title,
                body: input.body,
                pinned: input.pinned
            })
        );
        if (!written) throw new McpRefusal("That note no longer exists.");
        return { text: "Updated.", structured: { id: input.noteId } };
    }
};

/** Every note this account can open, for `polaris_search`. */
export const NOTE_SEARCH = defineMcpSearch({
    id: "notes.notes",
    app: "notes",
    category: "productivity",
    scope: "notes.use",
    async search(query, caller, limit) {
        const { access, shelves: shelfService } = await services();
        const actor = actorFor(caller);
        const shelves = await shelfService.listShelves(actor, await access.visibleSpaceIds(actor));
        const rows = await notesOn(caller, shelves);
        return preferMatches(rows, query, NOTE_FIELDS, limit).map((note) => ({
            id: note.id,
            name: note.title,
            kind: "note",
            where: note.notebook,
            keywords: [note.excerpt],
            next: [
                { tool: "notes_get", args: { noteId: note.id } },
                { tool: "notes_update", args: { noteId: note.id } }
            ]
        }));
    }
});

export const NOTE_TOOLS = [
    listNotesTool,
    getNoteTool,
    createNoteTool,
    updateNoteTool
] as unknown as McpTool<never>[];
