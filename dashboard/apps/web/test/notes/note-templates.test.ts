/**
 * Note templates: who may use and manage them, and the one-default rule.
 *
 * A template sits on a shelf the way a note does, so a template from another
 * notebook is refused rather than copied across, managing one takes the role
 * that writes notes there, and making one the default unsets the others on the
 * same shelf only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "0190a1b2-c3d4-7e5f-8a9b-0000000000aa";
const OTHER = "0190a1b2-c3d4-7e5f-8a9b-0000000000bb";

interface Template {
    id: string;
    ownerId: string;
    spaceId: string | null;
    title: string;
    body: string;
}

let templates: Template[] = [];
let count = 0;
const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const update = vi.fn(async (_args: unknown) => ({}));
const create = vi.fn(async (_args: unknown) => ({ id: "new-template" }));
const requireShelf = vi.fn(async (..._args: unknown[]) => "member");

vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: async (entries: unknown[]) => Promise.all(entries),
        noteTemplate: {
            findUnique: async (args: { where: { id: string } }) =>
                templates.find((template) => template.id === args.where.id) ?? null,
            count: async () => count,
            create: (args: unknown) => create(args),
            update: (args: unknown) => update(args),
            updateMany: (args: unknown) => updateMany(args),
            deleteMany: async () => ({ count: 1 })
        },
        note: {
            findUnique: async () => ({ title: "Meeting", body: "## Agenda" })
        }
    }
}));

vi.mock("@/lib/notes/access", () => {
    class NoteAccessError extends Error {}
    return {
        NoteAccessError,
        requireShelf: (...args: unknown[]) => requireShelf(...args),
        requireNote: async (_actor: unknown, noteId: string) => ({
            noteId,
            spaceId: SPACE,
            folderId: null,
            ownerId: "author"
        })
    };
});

const service = await import("@/lib/notes/template-service");
const actor = { id: "user-1", isAdmin: false };

beforeEach(() => {
    templates = [
        { id: "t-space", ownerId: "author", spaceId: SPACE, title: "Weekly", body: "- [ ] item" },
        { id: "t-own", ownerId: "user-1", spaceId: null, title: "Journal", body: "Today" }
    ];
    count = 0;
    updateMany.mockClear();
    update.mockClear();
    create.mockClear();
    requireShelf.mockClear();
});

describe("starting a note from a template", () => {
    it("copies the template on its own shelf", async () => {
        expect(await service.templateForPlacement(actor, "t-space", SPACE)).toEqual({
            title: "Weekly",
            body: "- [ ] item"
        });
        expect(requireShelf).toHaveBeenCalledWith(actor, { spaceId: SPACE, ownerId: "author" }, "guest");
    });

    it("refuses a template from another notebook", async () => {
        await expect(service.templateForPlacement(actor, "t-space", OTHER)).rejects.toThrow(
            /different notebook/
        );
        await expect(service.templateForPlacement(actor, "t-own", SPACE)).rejects.toThrow(/different notebook/);
    });

    it("refuses one the reader cannot reach", async () => {
        requireShelf.mockRejectedValueOnce(new Error("no"));
        await expect(service.templateForPlacement(actor, "t-space", SPACE)).rejects.toThrow();
    });

    it("refuses one that is gone", async () => {
        await expect(service.templateForPlacement(actor, "missing", SPACE)).rejects.toThrow(/no longer exists/);
    });
});

describe("managing templates", () => {
    it("saves a note as the shelf's first template, which becomes the default", async () => {
        await service.templateFromNote(actor, { noteId: "n1", name: "Minutes" });
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spaceId: SPACE,
                    name: "Minutes",
                    title: "Meeting",
                    body: "## Agenda",
                    isDefault: true
                })
            })
        );
    });

    it("stops at the cap", async () => {
        count = 50;
        await expect(service.templateFromNote(actor, { noteId: "n1", name: "One more" })).rejects.toThrow(/at most/);
        expect(create).not.toHaveBeenCalled();
    });

    it("making one the default unsets the others on its shelf only", async () => {
        await service.updateTemplate(actor, { templateId: "t-space", isDefault: true });
        expect(requireShelf).toHaveBeenCalledWith(actor, { spaceId: SPACE, ownerId: "author" }, "member");
        expect(updateMany).toHaveBeenCalledWith({
            where: { spaceId: SPACE, isDefault: true, id: { not: "t-space" } },
            data: { isDefault: false }
        });
    });

    it("on the private shelf the others are the owner's own", async () => {
        await service.updateTemplate(actor, { templateId: "t-own", isDefault: true });
        expect(updateMany).toHaveBeenCalledWith({
            where: { spaceId: null, ownerId: "user-1", isDefault: true, id: { not: "t-own" } },
            data: { isDefault: false }
        });
    });

    it("a rename touches nothing else", async () => {
        await service.updateTemplate(actor, { templateId: "t-own", name: "Diary" });
        expect(updateMany).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledWith({ where: { id: "t-own" }, data: { name: "Diary" } });
    });
});
