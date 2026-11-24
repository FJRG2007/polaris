/**
 * A note made, moved, renamed, pinned, archived or deleted with Polaris out of reach: sent at once when it
 * can be, kept on the device when it cannot, drawn in the tree from there with
 * its waiting state, and sent in order (the create first, its text after) when
 * Polaris answers.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createNoteAction = vi.fn();
const moveNoteAction = vi.fn();
const deleteNoteAction = vi.fn();
const saveNoteTextAction = vi.fn();
const updateNoteAction = vi.fn();
const templateContentsAction = vi.fn();
vi.mock("@/app/(app)/notes/actions", () => ({
    updateNoteAction: (input: unknown) => updateNoteAction(input),
    templateContentsAction: (ids: unknown) => templateContentsAction(ids),
    createNoteAction: (input: unknown) => createNoteAction(input),
    moveNoteAction: (input: unknown) => moveNoteAction(input),
    deleteNoteAction: (noteId: unknown) => deleteNoteAction(noteId),
    saveNoteTextAction: (input: unknown) => saveNoteTextAction(input)
}));
vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const { NOTE_CREATE, NOTE_DELETE, NOTE_MOVE, NOTE_UPDATE, saveNoteText, writeNote } = await import(
    "@/app/(app)/notes/offline-writes"
);
const { deletedHere, failedPlacement, localNote, noteAsHere, pendingUpdate, withNoteWrites } = await import(
    "@/app/(app)/notes/offline-tree"
);
const { keptTemplate, refreshKeptTemplates } = await import("@/app/(app)/notes/offline-templates");

import type { AppWrite } from "@/lib/offline/app-writes";
import type { NoteSummary } from "@/lib/notes/note-service";
import type { ShelfData } from "@/app/(app)/notes/note-tree";

const NOTE = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const OTHER = "0190a1b2-c3d4-7e5f-8a9b-000000000002";
const SPACE = "0190a1b2-c3d4-7e5f-8a9b-000000000003";
const unreachable = () => new TypeError("Failed to fetch");

async function drained(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
        appWrites.flush();
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const waiting = async () =>
    (await appWrites.readAll())
        .filter((entry) => entry.kind.startsWith("note."))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const summary = (id: string, extra: Partial<NoteSummary> = {}): NoteSummary => ({
    id,
    title: `Note ${id.slice(-1)}`,
    excerpt: "",
    pinned: false,
    parentId: null,
    folderId: null,
    depth: 0,
    hasChildren: false,
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...extra
});

const shelf = (notes: NoteSummary[], spaceId: string | null = null): ShelfData => ({
    space: spaceId
        ? { id: spaceId, name: "Team", icon: null, color: "#7c5cff", visibility: "private", orgId: null, role: "owner" }
        : null,
    folders: [],
    notes
});

const entry = (kind: string, target: string, payload: unknown, extra: Partial<AppWrite> = {}): AppWrite => ({
    key: `${kind}-${target}`,
    kind,
    target,
    payload,
    createdAt: "2026-11-02T10:00:00.000Z",
    state: "pending",
    attempts: 0,
    ...extra
});

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    for (const action of [
        createNoteAction,
        moveNoteAction,
        deleteNoteAction,
        saveNoteTextAction,
        updateNoteAction,
        templateContentsAction
    ])
        action.mockReset();
});

describe("a note made, moved or deleted offline", () => {
    it("is sent at once when Polaris answers, made with the id the device chose", async () => {
        createNoteAction.mockImplementation(async (input: { id: string }) => ({ id: input.id }));
        const result = await writeNote(NOTE_CREATE, { title: "Untitled", body: "" }, vi.fn());
        expect(result?.queued).toBeUndefined();
        expect(result?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(createNoteAction).toHaveBeenCalledWith(expect.objectContaining({ id: result?.id }));
        expect(await waiting()).toHaveLength(0);
    });

    it("is kept when Polaris does not answer, and answers the id it will be made with", async () => {
        createNoteAction.mockRejectedValue(unreachable());
        const result = await writeNote(NOTE_CREATE, { title: "Untitled", body: "" }, vi.fn());
        expect(result).toEqual({ id: expect.any(String), queued: true });
        const [kept] = await waiting();
        expect(kept).toMatchObject({ kind: NOTE_CREATE, target: result?.id, state: "pending" });
    });

    it("fails as it always did when the server threw, instead of keeping it", async () => {
        moveNoteAction.mockRejectedValue(new Error("boom"));
        const failure = vi.fn();
        const result = await writeNote(NOTE_MOVE, { noteId: NOTE, parentId: null, spaceId: null, folderId: null }, failure);
        expect(result).toBeNull();
        expect(failure).toHaveBeenCalled();
        expect(await waiting()).toHaveLength(0);
    });

    it("moves a note made here behind its create, never into it", async () => {
        createNoteAction.mockRejectedValue(unreachable());
        const made = await writeNote(NOTE_CREATE, { title: "Untitled", body: "", spaceId: null }, vi.fn());
        const moved = await writeNote(
            NOTE_MOVE,
            { noteId: made?.id, parentId: null, spaceId: SPACE, folderId: null },
            vi.fn()
        );
        expect(moved).toEqual({ queued: true });
        expect(moveNoteAction).not.toHaveBeenCalled();
        const kept = await waiting();
        expect(kept.map((one) => one.kind)).toEqual([NOTE_CREATE, NOTE_MOVE]);
        expect(kept[0]!.payload).toMatchObject({ id: made?.id, spaceId: null });
        const opened = localNote(kept, new Map(), made!.id!);
        expect(noteAsHere(opened!, kept)).toMatchObject({ spaceId: SPACE });
    });

    it("drops the create and text of a note deleted before it was sent, and sends the delete alone", async () => {
        createNoteAction.mockRejectedValue(unreachable());
        deleteNoteAction.mockRejectedValue(unreachable());
        const made = await writeNote(NOTE_CREATE, { title: "Untitled", body: "" }, vi.fn());
        await saveNoteText({ noteId: made!.id!, title: "Draft", body: "<p>x</p>", base: null });
        expect(await writeNote(NOTE_DELETE, { noteId: made?.id }, vi.fn())).toEqual({ queued: true });
        expect((await waiting()).map((one) => one.kind)).toEqual([NOTE_DELETE]);
        expect(localNote(await waiting(), new Map(), made!.id!)).toBeNull();

        // The create may have been on its way already; a delete of a note the
        // server does not have is answered as done.
        createNoteAction.mockReset();
        deleteNoteAction.mockReset();
        deleteNoteAction.mockResolvedValue({});
        await drained();
        expect(createNoteAction).not.toHaveBeenCalled();
        expect(deleteNoteAction).toHaveBeenCalledWith(made?.id);
        expect(await waiting()).toHaveLength(0);
    });

    it("folds a move behind a move, and drops what waits for a note that is deleted", async () => {
        moveNoteAction.mockRejectedValue(unreachable());
        deleteNoteAction.mockRejectedValue(unreachable());
        await writeNote(NOTE_MOVE, { noteId: NOTE, parentId: null, spaceId: SPACE, folderId: null }, vi.fn());
        await writeNote(NOTE_MOVE, { noteId: NOTE, parentId: null, spaceId: null, folderId: null }, vi.fn());
        let kept = await waiting();
        expect(kept).toHaveLength(1);
        expect(kept[0]!.payload).toMatchObject({ spaceId: null });
        await writeNote(NOTE_DELETE, { noteId: NOTE }, vi.fn());
        kept = await waiting();
        expect(kept.map((one) => one.kind)).toEqual([NOTE_DELETE]);
    });

    it("waits behind a parent made here, and sends the create before the text", async () => {
        createNoteAction.mockRejectedValueOnce(unreachable());
        const parent = await writeNote(NOTE_CREATE, { title: "Parent", body: "" }, vi.fn());
        // Polaris is back, but the child names a parent it does not have yet.
        const child = await writeNote(NOTE_CREATE, { title: "Child", body: "", parentId: parent?.id }, vi.fn());
        expect(child?.queued).toBe(true);
        await saveNoteText({ noteId: parent!.id!, title: "Parent", body: "<p>words</p>", base: null });

        const order: string[] = [];
        createNoteAction.mockImplementation(async (input: { id: string; title: string }) => {
            order.push(`create ${input.title}`);
            return { id: input.id };
        });
        saveNoteTextAction.mockImplementation(async () => {
            order.push("text");
            return { updatedAt: "2026-11-02T10:00:00.000Z" };
        });
        await drained();
        expect(order).toEqual(["create Parent", "create Child", "text"]);
        expect(await waiting()).toHaveLength(0);
    });

    it("answers a replayed delete of a note already gone as done", async () => {
        deleteNoteAction.mockRejectedValueOnce(unreachable());
        await writeNote(NOTE_DELETE, { noteId: NOTE }, vi.fn());
        deleteNoteAction.mockResolvedValue({});
        await drained();
        expect(await waiting()).toHaveLength(0);
    });
});

describe("a note renamed, pinned or archived offline", () => {
    it("is sent at once when Polaris answers", async () => {
        updateNoteAction.mockResolvedValue({});
        expect(await writeNote(NOTE_UPDATE, { noteId: NOTE, pinned: true }, vi.fn())).toEqual({});
        expect(updateNoteAction).toHaveBeenCalledWith({ noteId: NOTE, pinned: true });
        expect(await waiting()).toHaveLength(0);
    });

    it("is kept when Polaris does not answer, folding a change behind a change", async () => {
        updateNoteAction.mockRejectedValue(unreachable());
        expect(await writeNote(NOTE_UPDATE, { noteId: NOTE, title: "First" }, vi.fn())).toEqual({ queued: true });
        await writeNote(NOTE_UPDATE, { noteId: NOTE, pinned: true }, vi.fn());
        await writeNote(NOTE_UPDATE, { noteId: NOTE, title: "Second" }, vi.fn());
        const kept = await waiting();
        expect(kept).toHaveLength(1);
        expect(kept[0]!.payload).toEqual({ noteId: NOTE, title: "Second", pinned: true });
        expect(pendingUpdate(kept, NOTE)).toEqual({ title: "Second", pinned: true });

        updateNoteAction.mockReset();
        updateNoteAction.mockResolvedValue({});
        await drained();
        expect(updateNoteAction).toHaveBeenCalledTimes(1);
        expect(await waiting()).toHaveLength(0);
    });

    it("waits behind the create of a note made here, then sends both in order", async () => {
        createNoteAction.mockRejectedValueOnce(unreachable());
        const made = await writeNote(NOTE_CREATE, { title: "Untitled", body: "" }, vi.fn());
        // Polaris is back, but the note is not on it yet.
        const pinned = await writeNote(NOTE_UPDATE, { noteId: made?.id, pinned: true, title: "Named" }, vi.fn());
        expect(pinned).toEqual({ queued: true });
        expect(updateNoteAction).not.toHaveBeenCalled();

        const order: string[] = [];
        createNoteAction.mockImplementation(async (input: { id: string }) => {
            order.push("create");
            return { id: input.id };
        });
        updateNoteAction.mockImplementation(async () => {
            order.push("update");
            return {};
        });
        await drained();
        expect(order).toEqual(["create", "update"]);
    });

    it("is drawn: renamed and pinned to the top, archived out of the tree, refused as Polaris has it", () => {
        const shelves = [shelf([summary(OTHER, { pinned: true }), summary(NOTE)])];
        const [pinnedNow] = withNoteWrites(shelves, [
            entry(NOTE_UPDATE, NOTE, { noteId: NOTE, title: "Renamed", pinned: true })
        ]);
        expect(pinnedNow!.notes.map((note) => note.id)).toEqual([NOTE, OTHER]);
        expect(pinnedNow!.notes[0]).toMatchObject({ title: "Renamed", pinned: true, offline: "pending" });

        const [archived] = withNoteWrites(shelves, [entry(NOTE_UPDATE, OTHER, { noteId: OTHER, archived: true })]);
        expect(archived!.notes.map((note) => note.id)).toEqual([NOTE]);

        const refused = entry(NOTE_UPDATE, NOTE, { noteId: NOTE, archived: true }, { state: "failed", reason: "" });
        const [kept] = withNoteWrites(shelves, [refused]);
        expect(kept!.notes.find((note) => note.id === NOTE)).toMatchObject({ offline: "failed", title: "Note 1" });
        expect(failedPlacement([refused], NOTE)).toBe(refused);
        expect(pendingUpdate([refused], NOTE)).toEqual({});
    });
});

describe("a note made offline from a template", () => {
    const TEMPLATE = "0190a1b2-c3d4-7e5f-8a9b-000000000009";
    const listed = [{ id: TEMPLATE, spaceId: null, name: "Standup", isDefault: true, version: "v1" }];

    it("starts from the copy of the template this device keeps", async () => {
        templateContentsAction.mockResolvedValue([
            { id: TEMPLATE, title: "Standup", body: "<p>Yesterday</p>", version: "v1" }
        ]);
        expect(await refreshKeptTemplates(listed)).toBe(1);
        // Kept and current: nothing is asked again.
        expect(await refreshKeptTemplates(listed)).toBe(0);
        expect(templateContentsAction).toHaveBeenCalledTimes(1);
        expect(await refreshKeptTemplates([{ ...listed[0]!, version: "v2" }])).toBe(1);

        createNoteAction.mockRejectedValue(unreachable());
        const made = await writeNote(NOTE_CREATE, { title: "Untitled", body: "", templateId: TEMPLATE }, vi.fn());
        const opened = localNote(await waiting(), new Map(), made!.id!);
        expect(opened).toMatchObject({ title: "Standup", body: "<p>Yesterday</p>" });
        // The server still applies the template itself.
        expect((await waiting())[0]!.payload).toMatchObject({ templateId: TEMPLATE });
    });

    it("starts blank, as before, from a template this device never kept", async () => {
        expect(await keptTemplate(TEMPLATE)).toBeNull();
        createNoteAction.mockRejectedValue(unreachable());
        const made = await writeNote(NOTE_CREATE, { title: "Untitled", body: "", templateId: TEMPLATE }, vi.fn());
        expect(localNote(await waiting(), new Map(), made!.id!)).toMatchObject({ title: "Untitled", body: "" });
    });
});

describe("the tree drawn over what the device holds", () => {
    it("shows a note made here, newest first after the pinned ones, as waiting", () => {
        const shelves = [shelf([summary(OTHER, { pinned: true }), summary(NOTE)])];
        const made = entry(NOTE_CREATE, "new", { id: "new", title: "Fresh", body: "" });
        const [own] = withNoteWrites(shelves, [made]);
        expect(own!.notes.map((note) => note.id)).toEqual([OTHER, "new", NOTE]);
        expect(own!.notes[1]).toMatchObject({ title: "Fresh", offline: "pending", unsent: true });
    });

    it("moves a note to the shelf it was moved to, and hides one deleted", () => {
        const shelves = [shelf([summary(NOTE), summary(OTHER)]), shelf([], SPACE)];
        const [own, team] = withNoteWrites(shelves, [
            entry(NOTE_MOVE, NOTE, { noteId: NOTE, parentId: null, spaceId: SPACE, folderId: null }),
            entry(NOTE_DELETE, OTHER, { noteId: OTHER })
        ]);
        expect(own!.notes).toHaveLength(0);
        expect(team!.notes.map((note) => note.id)).toEqual([NOTE]);
        expect(team!.notes[0]).toMatchObject({ offline: "pending" });
    });

    it("draws a delete Polaris refused again, marked as not sent", () => {
        const refused = entry(NOTE_DELETE, NOTE, { noteId: NOTE }, { state: "failed", reason: "No access" });
        const [own] = withNoteWrites([shelf([summary(NOTE)])], [refused]);
        expect(own!.notes[0]).toMatchObject({ id: NOTE, offline: "failed" });
        expect(deletedHere([refused], NOTE)).toBe(false);
        expect(failedPlacement([refused], NOTE)).toBe(refused);
    });

    it("lifts a note out from under a parent that is gone, and says who has children", () => {
        const shelves = [shelf([summary(NOTE, { hasChildren: true }), summary(OTHER, { parentId: NOTE, depth: 1 })])];
        const [own] = withNoteWrites(shelves, [entry(NOTE_DELETE, NOTE, { noteId: NOTE })]);
        expect(own!.notes).toEqual([expect.objectContaining({ id: OTHER, parentId: null, hasChildren: false })]);

        const made = entry(NOTE_CREATE, "kid", { id: "kid", title: "Kid", body: "", parentId: OTHER });
        const [again] = withNoteWrites([shelf([summary(OTHER)])], [made]);
        expect(again!.notes.find((note) => note.id === OTHER)?.hasChildren).toBe(true);
    });

    it("shows a title typed offline, without a clock until it has failed to reach Polaris", () => {
        const typed = entry("note.text", NOTE, { noteId: NOTE, title: "Renamed", body: "", base: null });
        const [own] = withNoteWrites([shelf([summary(NOTE)])], [typed]);
        expect(own!.notes[0]).toMatchObject({ title: "Renamed" });
        expect(own!.notes[0]).not.toHaveProperty("offline");
        const [late] = withNoteWrites([shelf([summary(NOTE)])], [{ ...typed, attempts: 1 }]);
        expect(late!.notes[0]).toMatchObject({ offline: "pending" });
    });

    it("opens a note made here from what it was made with, also once sent", () => {
        const made = entry(NOTE_CREATE, "new", { id: "new", title: "Fresh", body: "<p>a</p>", spaceId: SPACE });
        expect(localNote([made], new Map(), "new")).toMatchObject({ id: "new", title: "Fresh", spaceId: SPACE });
        expect(localNote([], new Map([["new", made]]), "new")).toMatchObject({ id: "new" });
        expect(localNote([], new Map(), "new")).toBeNull();
    });
});
