/**
 * One note shared on its own (`note.note`). A "view" grant opens it and changes
 * nothing; an "edit" grant also changes its title and text, and nothing else
 * (not pinning, archiving or moving); and only whoever runs its shelf may hand
 * it out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOTE = "0192f0aa-0000-7000-8000-0000000000f1";

const state = vi.hoisted(() => ({ held: "", updated: [] as unknown[] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        note: {
            findUnique: vi.fn(async () => ({
                id: "0192f0aa-0000-7000-8000-0000000000f1",
                userId: "owner",
                spaceId: null,
                folderId: null
            }))
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedCapability: vi.fn(async () => state.held),
    grantedSubjects: vi.fn(async () => new Map()),
    dropGrantsFor: vi.fn(),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async () => ({ id: "reader", isAdmin: false })),
    sessionCan: vi.fn(async () => false)
}));
vi.mock("@/lib/notes/note-service", () => ({
    updateNote: vi.fn(async (input: unknown) => {
        state.updated.push(input);
        return true;
    })
}));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => null }));
vi.mock("@/lib/orgs/org-service", () => ({
    administeredOrgIds: vi.fn(async () => []),
    memberOrgIds: vi.fn(async () => []),
    listAdministeredOrgs: vi.fn(async () => [])
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers()
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));
vi.mock("@/lib/local-machine", () => ({
    isLocalMachine: vi.fn(() => false),
    localMachineIdentity: vi.fn(async () => null)
}));
vi.mock("@/lib/local-server", () => ({
    getLocalServerName: vi.fn(async () => null),
    LOCAL_SERVER_FALLBACK_NAME: "This server"
}));

const access = await import("@/lib/notes/access");
const actions = await import("@/app/(app)/notes/actions");
const { requireMayShare } = await import("@/lib/access/sharing-service");

const reader = { id: "reader", isAdmin: false };

describe("a note shared on its own", () => {
    beforeEach(() => {
        state.held = "";
        state.updated = [];
    });

    it("opens only with a grant, and says which", async () => {
        expect(await access.sharedNote(reader, NOTE)).toBeNull();
        state.held = "view";
        expect(await access.sharedNote(reader, NOTE)).toBe("view");
        await expect(access.requireNote(reader, NOTE, "guest")).rejects.toThrow();
    });

    it("lets a view grant change nothing, and an edit grant change only the text", async () => {
        state.held = "view";
        expect((await actions.updateNoteAction({ noteId: NOTE, title: "x" })).error).toBeTruthy();
        state.held = "edit";
        expect(await actions.updateNoteAction({ noteId: NOTE, title: "x", body: "y" })).toEqual({});
        expect(
            (await actions.updateNoteAction({ noteId: NOTE, archived: true })).error
        ).toBeTruthy();
        expect((await actions.updateNoteAction({ noteId: NOTE, pinned: true })).error).toBeTruthy();
        expect(state.updated).toHaveLength(1);
    });

    it("may be handed out by its owner and by nobody else", async () => {
        const as = (id: string) =>
            ({ id, isAdmin: false }) as Parameters<typeof requireMayShare>[0];
        await expect(requireMayShare(as("reader"), "note.note", NOTE)).rejects.toThrow();
        await expect(requireMayShare(as("owner"), "note.note", NOTE)).resolves.toBeUndefined();
    });
});
