/**
 * The question asked before anything lands in a folder: which names are taken.
 *
 * What the dialog offers is drawn from this answer, so it has to match what the
 * writes will allow - Replace only for a file the person may change, Merge for
 * a folder upload onto a folder but not for a move, and Keep both for a folder
 * made under its own "(n)" name before its files are sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDriver, type MemoryDriver } from "./fixtures/memory-driver";

const authorizeDrive = vi.fn();
const getDriverForConnection = vi.fn();

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/trash-service", () => ({ hasTrash: () => true }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection }));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class DriveAccessError extends Error {},
    DriveLockedError: class DriveLockedError extends Error {},
    authorizeDrive,
    drivePathFilter: async () => async () => true
}));

const actions = await import("../../src/app/(app)/drive/conflict-actions");
const authz = await import("@/lib/drive-authz");

let storage: MemoryDriver;

beforeEach(() => {
    vi.clearAllMocks();
    authorizeDrive.mockResolvedValue(undefined);
    storage = memoryDriver({
        files: { "docs/a.txt": "1", "docs/album/x.jpg": "2", "docs/locked.txt": "3" },
        dirs: ["docs", "docs/album"]
    });
    getDriverForConnection.mockResolvedValue(storage.driver);
});

function clashes(entries: { path: string; kind: "file" | "dir" }[], merge = true) {
    return actions.nameClashesAction({ connectionId: "conn-1", folder: "docs", entries, merge });
}

describe("checking a folder for names already taken", () => {
    it("lists only the clashes, relative to the folder, ignoring case", async () => {
        const answer = await clashes([
            { path: "A.TXT", kind: "file" },
            { path: "free.txt", kind: "file" },
            { path: "album", kind: "dir" }
        ]);
        expect(answer).toEqual({
            clashes: [
                expect.objectContaining({ path: "A.TXT", existingName: "a.txt", canReplace: true }),
                expect.objectContaining({ path: "album", incomingKind: "dir", canReplace: true })
            ]
        });
    });

    it("withholds Replace from a file the person may not change, saying why", async () => {
        authorizeDrive.mockImplementation(async (_user: string, _conn: string, path: string) => {
            if (path === "docs/locked.txt") throw new authz.DriveAccessError();
        });
        const answer = await clashes([{ path: "locked.txt", kind: "file" }]);
        expect(answer).toEqual({
            clashes: [expect.objectContaining({ canReplace: false, replaceBlocked: "permission" })]
        });
    });

    it("does not offer to merge a folder that is being moved or copied", async () => {
        const answer = await clashes([{ path: "album", kind: "dir" }], false);
        expect(answer).toEqual({
            clashes: [expect.objectContaining({ canReplace: false, replaceBlocked: "merge" })]
        });
    });

    it("does not offer to replace a file with a folder", async () => {
        const answer = await clashes([{ path: "a.txt", kind: "dir" }]);
        expect(answer).toEqual({
            clashes: [expect.objectContaining({ canReplace: false, replaceBlocked: "kind" })]
        });
    });

    it("checks the files inside a folder being merged, in their own folder", async () => {
        const answer = await clashes([
            { path: "album/x.jpg", kind: "file" },
            { path: "album/y.jpg", kind: "file" }
        ]);
        expect(answer).toEqual({ clashes: [expect.objectContaining({ path: "album/x.jpg" })] });
    });

    it("refuses a path that climbs out of the folder", async () => {
        const answer = await clashes([{ path: "../secret.txt", kind: "file" }]);
        expect(answer).toEqual({ error: "conflicts.checkFailed" });
    });

    it("refuses somebody who cannot write in the folder", async () => {
        authorizeDrive.mockRejectedValue(new authz.DriveAccessError());
        expect(await clashes([{ path: "a.txt", kind: "file" }])).toEqual({ error: "errors.cannotWrite" });
    });
});

describe("keeping both folders", () => {
    it("makes the uploaded folder as name (1) and returns that name", async () => {
        const answer = await actions.reserveFolderAction({
            connectionId: "conn-1",
            folder: "docs",
            name: "album"
        });
        expect(answer).toEqual({ name: "album (1)" });
        expect(storage.dirs.has("docs/album (1)")).toBe(true);
    });

    it("refuses a name that is a path", async () => {
        const answer = await actions.reserveFolderAction({
            connectionId: "conn-1",
            folder: "docs",
            name: "a/b"
        });
        expect(answer).toEqual({ error: "errors.createFolderFailed" });
    });
});
