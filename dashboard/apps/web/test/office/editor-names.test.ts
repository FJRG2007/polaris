/**
 * The "last edited by" line on a shared document.
 *
 * Everybody the document is shared with reads it, so it is a name or a handle
 * and never the editor's email address - even for an account with no name.
 */

import { describe, expect, it, vi } from "vitest";

const asked: { select: Record<string, boolean> }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async (query: { select: Record<string, boolean> }) => {
                asked.push(query);
                return [
                    { id: "editor-1", name: "Editor One", username: "editor1" },
                    { id: "editor-2", name: "", username: "editor2" },
                    { id: "editor-3", name: "", username: null }
                ];
            }
        }
    }
}));

const { nameEditors } = await import("@/lib/office/documents");

describe("who last edited a document", () => {
    it("is a name, a handle, or nothing, and never an address", async () => {
        const names = await nameEditors([
            { editedById: "editor-1" },
            { editedById: "editor-2" },
            { editedById: "editor-3" },
            { editedById: null }
        ]);
        expect([...names]).toEqual([
            ["editor-1", "Editor One"],
            ["editor-2", "@editor2"],
            ["editor-3", ""]
        ]);
        expect(asked.at(-1)?.select.email).toBeUndefined();
    });
});
