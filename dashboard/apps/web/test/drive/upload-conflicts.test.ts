/**
 * An upload onto a name already taken.
 *
 * Before this, the route wrote straight onto the name and the file that held it
 * was gone. Now it does what the uploader chose and nothing else: the default
 * refuses with a 409 the screen asks about, Keep both saves "name (1).ext",
 * Replace puts the old file in the bin - and only for somebody allowed to
 * change that file. The race is the case the default exists for: two uploads
 * both told the name was free, where the second must not land on the first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDriver, type MemoryDriver } from "./fixtures/memory-driver";

const authorizeDrive = vi.fn();
const getDriverForConnection = vi.fn();
const trashWithDriver = vi.fn();
const hasTrash = vi.fn(() => true);

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "writer-1", isAdmin: false }) }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => true }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/drive-meta-service", () => ({ recordItemCreator: async () => undefined }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: async () => undefined }));
vi.mock("@/lib/trash-service", () => ({ hasTrash, trashWithDriver }));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class DriveAccessError extends Error {},
    DriveLockedError: class DriveLockedError extends Error {},
    authorizeDrive
}));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection }));

const route = await import("../../src/app/api/drive/upload/route");
const authz = await import("@/lib/drive-authz");

let storage: MemoryDriver;

function upload(name: string, body: string, conflict?: string, p = "docs"): Promise<Response> {
    const query = new URLSearchParams({ c: "conn-1", p, name });
    if (conflict) query.set("conflict", conflict);
    return route.PUT(
        new Request(`https://polaris.test/api/drive/upload?${query}`, { method: "PUT", body })
    );
}

function useStorage(next: MemoryDriver) {
    storage = next;
    getDriverForConnection.mockResolvedValue(next.driver);
}

beforeEach(() => {
    vi.clearAllMocks();
    authorizeDrive.mockResolvedValue(undefined);
    hasTrash.mockReturnValue(true);
    trashWithDriver.mockImplementation(
        async (_driver: unknown, _user: string, _conn: string, path: string) => {
            storage.files.delete(path);
        }
    );
    useStorage(memoryDriver({ files: { "docs/a.txt": "old" }, dirs: ["docs"] }));
});

describe("an upload onto a taken name", () => {
    it("is refused by default with the clash, and the file there is untouched", async () => {
        const answer = await upload("a.txt", "new");
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({
            error: "name_conflict",
            clash: {
                path: "a.txt",
                incomingKind: "file",
                existingName: "a.txt",
                existingKind: "file",
                canReplace: true,
                replaceBlocked: null,
                recoverable: true
            }
        });
        expect(storage.files.get("docs/a.txt")).toBe("old");
        expect([...storage.files.keys()]).toEqual(["docs/a.txt"]);
    });

    it("keeps both as a (1).txt", async () => {
        const answer = await upload("a.txt", "new", "keepBoth");
        expect(answer.status).toBe(200);
        expect((await answer.json()).name).toBe("a (1).txt");
        expect(storage.files.get("docs/a.txt")).toBe("old");
        expect(storage.files.get("docs/a (1).txt")).toBe("new");
    });

    it("replaces, putting the old file in the uploader's bin", async () => {
        const answer = await upload("a.txt", "new", "replace");
        expect(answer.status).toBe(200);
        expect(trashWithDriver).toHaveBeenCalledWith(
            storage.driver,
            "writer-1",
            "conn-1",
            "docs/a.txt"
        );
        expect([...storage.files.entries()]).toEqual([["docs/a.txt", "new"]]);
    });

    it("does not replace a file the uploader may not change", async () => {
        authorizeDrive.mockImplementation(async (_user: string, _conn: string, path: string) => {
            if (path === "docs/a.txt") throw new authz.DriveAccessError();
        });
        const answer = await upload("a.txt", "new", "replace");
        expect(answer.status).toBe(403);
        expect(trashWithDriver).not.toHaveBeenCalled();
        expect([...storage.files.entries()]).toEqual([["docs/a.txt", "old"]]);
    });

    it("tells the screen Replace is not on offer when the file is someone else's", async () => {
        authorizeDrive.mockImplementation(async (_user: string, _conn: string, path: string) => {
            if (path === "docs/a.txt") throw new authz.DriveAccessError();
        });
        const answer = await upload("a.txt", "new");
        const body = await answer.json();
        expect(body.clash.canReplace).toBe(false);
        expect(body.clash.replaceBlocked).toBe("permission");
    });

    it("says the old file is gone for good on a source with no bin, and overwrites it", async () => {
        hasTrash.mockReturnValue(false);
        expect((await (await upload("a.txt", "new")).json()).clash.recoverable).toBe(false);
        const answer = await upload("a.txt", "new", "replace");
        expect(answer.status).toBe(200);
        expect(trashWithDriver).not.toHaveBeenCalled();
        expect([...storage.files.entries()]).toEqual([["docs/a.txt", "new"]]);
    });

    it("clashes with a name in another case on a storage that ignores case", async () => {
        useStorage(
            memoryDriver(
                { files: { "docs/Report.PDF": "old" }, dirs: ["docs"] },
                { caseInsensitive: true }
            )
        );
        const answer = await upload("report.pdf", "new");
        expect(answer.status).toBe(409);
        expect((await answer.json()).clash.existingName).toBe("Report.PDF");
        expect(storage.files.get("docs/Report.PDF")).toBe("old");
    });

    it("never replaces a folder with a file", async () => {
        useStorage(memoryDriver({ dirs: ["docs", "docs/a.txt"] }));
        const answer = await upload("a.txt", "new", "replace");
        expect(answer.status).toBe(409);
        expect(storage.dirs.has("docs/a.txt")).toBe(true);
    });

    it("still writes in place for an editor saving the file it has open", async () => {
        const answer = await upload("a.txt", "edited", "overwrite");
        expect(answer.status).toBe(200);
        expect(authorizeDrive).toHaveBeenCalledWith("writer-1", "conn-1", "docs/a.txt", "write");
        expect(storage.files.get("docs/a.txt")).toBe("edited");
    });

    it("rejects a conflict mode it does not know", async () => {
        expect((await upload("a.txt", "new", "clobber")).status).toBe(400);
        expect(storage.files.get("docs/a.txt")).toBe("old");
    });
});

describe("two uploads racing for one free name", () => {
    it("lets one write it and answers the other with a 409, not an overwrite", async () => {
        const answers = await Promise.all([upload("b.txt", "first"), upload("b.txt", "second")]);
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
        const kept = storage.files.get("docs/b.txt");
        expect(["first", "second"]).toContain(kept);
    });
});

describe("a folder upload into a folder of the same name", () => {
    it("merges a new file into it", async () => {
        useStorage(
            memoryDriver({ files: { "docs/album/old.jpg": "1" }, dirs: ["docs", "docs/album"] })
        );
        expect((await upload("album/new.jpg", "2")).status).toBe(200);
        expect(storage.files.get("docs/album/new.jpg")).toBe("2");
        expect(storage.files.get("docs/album/old.jpg")).toBe("1");
    });

    it("asks about a file that is in both, by its path inside the upload", async () => {
        useStorage(
            memoryDriver({ files: { "docs/album/old.jpg": "1" }, dirs: ["docs", "docs/album"] })
        );
        const answer = await upload("album/old.jpg", "2");
        expect(answer.status).toBe(409);
        expect((await answer.json()).clash.path).toBe("album/old.jpg");
        expect(storage.files.get("docs/album/old.jpg")).toBe("1");
    });
});
