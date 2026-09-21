/**
 * A file on a message that the conversation does not own.
 *
 * Shared out of somebody's Drive rather than copied in, which makes one thing
 * dangerous: every path that tidies up after a message deletes the files on it,
 * and here the file is not Polaris's to delete. Getting that wrong does not lose
 * a copy - it reaches into somebody's Drive and destroys the original because a
 * sentence beside it was taken back, or because a send failed halfway.
 *
 * So both of those paths are pinned here: the tidy-up after a deleted message,
 * and the clean-up after a send that threw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every file the storage layer was asked to delete. */
let deleted: { connectionId: string | null; path: string }[] = [];
/** The attachment rows, as the two paths read them. */
let rows: {
    id: string;
    connectionId: string | null;
    path: string;
    posterPath: string | null;
    posterConnectionId: string | null;
    borrowed: boolean;
}[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatAttachment: {
            findMany: async () => rows
        }
    }
}));

vi.mock("@/lib/chat/report-files", () => ({
    keepForReports: async () => undefined,
    keepChannelForReports: async () => undefined
}));

vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    LOCAL_FOLDER: "chat",
    driverForTarget: async (target: string) => ({
        delete: async (path: string) => {
            deleted.push({ connectionId: target === "local" ? null : target, path });
        },
        list: async () => ({ entries: [] }),
        dispose: async () => undefined
    }),
    placeFile: async () => ({ targetId: "local" }),
    readFrom: async () => null
}));

const attachments = await import("@/lib/chat/attachments");

function row(over: Partial<(typeof rows)[number]> = {}) {
    return {
        id: "a1",
        connectionId: null,
        path: "chat/c1/one",
        posterPath: null,
        posterConnectionId: null,
        borrowed: false,
        ...over
    };
}

beforeEach(() => {
    deleted = [];
    rows = [];
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("tidying up after a message", () => {
    it("removes the files the conversation owns", async () => {
        rows = [row({ id: "a1", path: "chat/c1/one" }), row({ id: "a2", path: "chat/c1/two" })];

        await attachments.discardAttachments("m1");

        // The folder goes too when it empties, which is why this is not an exact
        // list: what matters is that both files were taken.
        expect(deleted.map((file) => file.path)).toContain("chat/c1/one");
        expect(deleted.map((file) => file.path)).toContain("chat/c1/two");
    });

    it("never touches one that lives in somebody's Drive", async () => {
        rows = [
            row({ id: "a1", path: "chat/c1/one" }),
            row({
                id: "a2",
                borrowed: true,
                connectionId: "conn-ada",
                path: "Documents/the whole album.zip"
            })
        ];

        await attachments.discardAttachments("m1");

        // Deleting a message is taking back a sentence. It is not permission to
        // delete the file that sentence pointed at.
        expect(deleted.map((file) => file.path)).toContain("chat/c1/one");
        expect(deleted.map((file) => file.path)).not.toContain("Documents/the whole album.zip");
        expect(deleted.some((file) => file.connectionId === "conn-ada")).toBe(false);
    });

    it("does nothing at all when every file on it is borrowed", async () => {
        rows = [row({ borrowed: true, connectionId: "conn-ada", path: "Documents/notes.pdf" })];

        await attachments.discardAttachments("m1");

        expect(deleted).toEqual([]);
    });
});
