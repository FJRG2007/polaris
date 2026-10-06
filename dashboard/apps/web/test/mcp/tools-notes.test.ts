/**
 * The notes tools, called the way an MCP client calls them.
 *
 * The notes services are tested on their own; what is pinned here is the
 * boundary: a key without `notes.use` is refused before anything is read, the
 * access layer is asked as the key's own account before a note is touched, its
 * refusal reaches the model as written, and a list comes back a page at a time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class NoteAccessError extends Error {}
    return {
        NoteAccessError,
        visibleSpaceIds: vi.fn(),
        requireNote: vi.fn(),
        requirePlacement: vi.fn(),
        listNotes: vi.fn(),
        getNote: vi.fn(),
        createNote: vi.fn(),
        updateNote: vi.fn(),
        listShelves: vi.fn()
    };
});

vi.mock("@polaris/db", () => ({ prisma: {} }));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/notes/access", () => ({
    NoteAccessError: mocks.NoteAccessError,
    visibleSpaceIds: mocks.visibleSpaceIds,
    requireNote: mocks.requireNote,
    requirePlacement: mocks.requirePlacement
}));
vi.mock("@/lib/notes/note-service", () => ({
    listNotes: mocks.listNotes,
    getNote: mocks.getNote,
    createNote: mocks.createNote,
    updateNote: mocks.updateNote
}));
vi.mock("@/lib/notes/shelf-service", () => ({ listShelves: mocks.listShelves }));

const { NOTE_TOOLS } = await import("@/lib/mcp/tools/notes");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

function call(name: string, args: Record<string, unknown>, scopes: string[] = ["notes.use"]) {
    return handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, keyId: "key-1" },
        SERVER
    );
}

function note(index: number) {
    return {
        id: `note-${index}`,
        title: index % 2 === 0 ? `Groceries ${index}` : `Meeting ${index}`,
        excerpt: "first line",
        pinned: false,
        parentId: null,
        folderId: null,
        depth: 0,
        hasChildren: false,
        updatedAt: "2026-10-01T00:00:00.000Z"
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.visibleSpaceIds.mockResolvedValue([SPACE_ID]);
    mocks.listShelves.mockResolvedValue([
        { space: null, folders: [] },
        { space: { id: SPACE_ID, name: "Team", role: "member" }, folders: [] }
    ]);
    mocks.requireNote.mockResolvedValue({
        noteId: NOTE_ID,
        spaceId: null,
        folderId: null,
        ownerId: "user-1"
    });
    mocks.requirePlacement.mockResolvedValue(undefined);
});

describe("the notes tools", () => {
    it("are all in the catalogue, reads before writes, each asking for notes.use", () => {
        const names = MCP_TOOLS.map((tool) => tool.name);
        for (const tool of NOTE_TOOLS) {
            expect(names).toContain(tool.name);
            expect(tool.scope, tool.name).toBe("notes.use");
        }
        const firstWrite = NOTE_TOOLS.findIndex((tool) => !tool.readOnly);
        expect(NOTE_TOOLS.slice(firstWrite).every((tool) => !tool.readOnly)).toBe(true);
    });

    it("refuse a key without notes.use before reaching the notes", async () => {
        const result = (await call("notes_create", { title: "x" }, ["tasks.read"]))
            ?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("notes.use");
        expect(mocks.requirePlacement).not.toHaveBeenCalled();
        expect(mocks.createNote).not.toHaveBeenCalled();
    });

    it("reject arguments of the wrong shape", async () => {
        expect((await call("notes_get", { noteId: "not-an-id" }))?.error?.code).toBe(-32602);
        expect((await call("notes_update", { noteId: NOTE_ID }))?.error?.code).toBe(-32602);
        expect((await call("notes_list", { limit: 500 }))?.error?.code).toBe(-32602);
        expect(mocks.getNote).not.toHaveBeenCalled();
        expect(mocks.updateNote).not.toHaveBeenCalled();
    });

    it("write a note as the key's own account, after the placement check", async () => {
        mocks.createNote.mockResolvedValue(NOTE_ID);
        const result = (await call("notes_create", { title: "Plan", body: "- a" }))
            ?.result as ToolResult;
        expect(mocks.requirePlacement).toHaveBeenCalledWith(
            { id: "user-1", isAdmin: false },
            { spaceId: null, folderId: null }
        );
        expect(mocks.createNote).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ title: "Plan", body: "- a", spaceId: null })
        );
        expect(result.structuredContent).toEqual({ id: NOTE_ID });
    });

    it("pass the access layer's refusal to the model and read nothing", async () => {
        mocks.requireNote.mockRejectedValue(new mocks.NoteAccessError("That is not yours to open"));
        const result = (await call("notes_get", { noteId: NOTE_ID }))?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe("That is not yours to open");
        expect(mocks.getNote).not.toHaveBeenCalled();
    });

    it("check for write access before changing a note", async () => {
        mocks.updateNote.mockResolvedValue(true);
        await call("notes_update", { noteId: NOTE_ID, pinned: true });
        expect(mocks.requireNote).toHaveBeenCalledWith(
            { id: "user-1", isAdmin: false },
            NOTE_ID,
            "member"
        );
        expect(mocks.updateNote).toHaveBeenCalledWith({ noteId: NOTE_ID, pinned: true });
    });

    it("list a page at a time, with where the next one starts", async () => {
        mocks.listNotes.mockImplementation(async (shelf: { spaceId: string | null }) =>
            shelf.spaceId ? [] : Array.from({ length: 30 }, (_, index) => note(index))
        );
        const result = (await call("notes_list", { limit: 10 }))?.result as ToolResult;
        expect(mocks.listNotes).toHaveBeenCalledWith({ userId: "user-1", spaceId: null });
        expect(result.structuredContent.notes).toHaveLength(10);
        expect(result.structuredContent.nextOffset).toBe(10);
        expect(Object.keys(result.structuredContent.notes[0]).sort()).toEqual(
            [
                "excerpt",
                "id",
                "notebook",
                "notebookId",
                "parentId",
                "pinned",
                "title",
                "updatedAt"
            ].sort()
        );

        const filtered = (await call("notes_list", { query: "meeting" }))?.result as ToolResult;
        expect(filtered.structuredContent.notes).toHaveLength(15);
        expect(filtered.structuredContent.nextOffset).toBeNull();
    });

    it("refuse a notebook the account cannot open", async () => {
        const result = (await call("notes_list", { notebook: "Someone else's" }))
            ?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(mocks.listNotes).not.toHaveBeenCalled();
        // Named with the ones it can, so the model can pick rather than stop.
        expect(result.content[0]?.text).toContain("private, Team");
    });

    it("find a notebook whatever the accents", async () => {
        mocks.listShelves.mockResolvedValue([
            { space: null, folders: [] },
            { space: { id: SPACE_ID, name: "Reuniones de Equipo", role: "member" }, folders: [] }
        ]);
        mocks.listNotes.mockResolvedValue([]);
        const result = (await call("notes_list", { notebook: "reuniónes de equipo" }))
            ?.result as ToolResult;
        expect(result.isError).toBeUndefined();
        expect(mocks.listNotes).toHaveBeenCalledWith({ userId: "user-1", spaceId: SPACE_ID });
    });

    it("find a note by a word in another language, and list them all when nothing matches", async () => {
        mocks.listNotes.mockImplementation(async (shelf: { spaceId: string | null }) =>
            shelf.spaceId ? [] : Array.from({ length: 4 }, (_, index) => note(index))
        );
        const found = (await call("notes_list", { query: "reunion" }))?.result as ToolResult;
        expect(found.structuredContent.notes[0].title).toMatch(/^Meeting/);
        expect(found.structuredContent.matched).toBe(true);

        const none = (await call("notes_list", { query: "zebra" }))?.result as ToolResult;
        expect(none.structuredContent.notes).toHaveLength(4);
        expect(none.structuredContent.matched).toBe(false);
        expect(none.content[0]?.text).toContain('No match for "zebra"; these are all 4 notes.');
    });

    it("cut a very long note rather than hand it over whole", async () => {
        mocks.getNote.mockResolvedValue({
            id: NOTE_ID,
            title: "Long",
            body: "x".repeat(60_000),
            pinned: false,
            parentId: null,
            spaceId: null,
            folderId: null,
            updatedAt: "2026-10-01T00:00:00.000Z"
        });
        const result = (await call("notes_get", { noteId: NOTE_ID }))?.result as ToolResult;
        expect(result.structuredContent.truncated).toBe(true);
        expect(result.structuredContent.body).toHaveLength(50_000);
    });
});
