/**
 * Deleting a drop point, and what happens to the folder it collected into.
 *
 * A drop point is created with a folder of its own, so the two are normally taken
 * out together - but they are two different systems, and the order matters. The
 * folder goes first: if storage refuses, the whole thing is called off with the row
 * intact, because the alternative is files nobody can reach from a drop point that
 * no longer exists. And a folder already gone is not a refusal - that end state is
 * the one that was asked for.
 */

import { StorageError } from "@polaris/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const REQUEST = "018f2b7a-0000-7000-8000-0000000000b1";
const CONNECTION = "018f2b7a-0000-7000-8000-0000000000e1";
const FOLDER = "Drop Points/Photos";

const getForOwner = vi.fn();
const deleteForOwner = vi.fn(async () => true);
const authorizeDrive = vi.fn(async () => undefined);
const driverDelete = vi.fn(async () => undefined);
const driverStat = vi.fn(async () => ({ kind: "dir" }));
const dispose = vi.fn(async () => undefined);
const recordAudit = vi.fn(async () => undefined);
const invalidateFolderSizes = vi.fn(async () => undefined);

class DriveAccessError extends Error {}
class DriveLockedError extends Error {}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "x" }) }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: OWNER }) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://polaris.test" }));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: async () => undefined }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "1.2.3.4",
    hashForLog: () => "h"
}));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true }),
    resetRateLimit: async () => undefined
}));
vi.mock("@/lib/storage-service", () => ({
    getDriverForConnection: async () => ({ delete: driverDelete, stat: driverStat, dispose }),
    SmbShareRequiredError: class extends Error {}
}));
vi.mock("@/lib/drive-authz", () => ({ authorizeDrive, DriveAccessError, DriveLockedError }));
vi.mock("@/lib/file-request-service", () => ({
    getFileRequestForOwner: getForOwner,
    deleteFileRequestForOwner: deleteForOwner
}));

const { deleteFileRequestAction, deleteFileRequestsAction } = await import(
    "../../src/app/(app)/drive/request-actions"
);

beforeEach(() => {
    // clearAllMocks forgets the calls, not the one-off outcomes a case installed,
    // so every mock that a test overrides is put back to its default by hand.
    vi.clearAllMocks();
    deleteForOwner.mockResolvedValue(true);
    driverDelete.mockResolvedValue(undefined);
    driverStat.mockResolvedValue({ kind: "dir" });
    authorizeDrive.mockResolvedValue(undefined);
    getForOwner.mockResolvedValue({
        id: REQUEST,
        destinationConnectionId: CONNECTION,
        destinationPath: FOLDER
    });
});

describe("deleting a drop point", () => {
    it("takes the folder with it when asked", async () => {
        expect(await deleteFileRequestAction(REQUEST, true)).toEqual({});

        expect(authorizeDrive).toHaveBeenCalledWith(OWNER, CONNECTION, FOLDER, "write");
        expect(driverDelete).toHaveBeenCalledWith(FOLDER, { recursive: true });
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, REQUEST);
        expect(dispose).toHaveBeenCalled();
    });

    it("leaves the folder alone when the choice is off", async () => {
        expect(await deleteFileRequestAction(REQUEST, false)).toEqual({});

        expect(driverDelete).not.toHaveBeenCalled();
        expect(authorizeDrive).not.toHaveBeenCalled();
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, REQUEST);
    });

    it("destroys nothing when the folder cannot be deleted", async () => {
        driverDelete.mockRejectedValue(new StorageError("io_error", "the share went away"));

        const result = await deleteFileRequestAction(REQUEST, true);

        expect(result.error).toContain("could not be deleted");
        // The drop point is still there, so the files are still reachable from it.
        expect(deleteForOwner).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("reports a backend that refuses the delete as the failure it is", async () => {
        // Read-only credentials, a changed ACL: the folder is real and still full, so
        // the drop point stays as the only thing still pointing at it.
        driverDelete.mockRejectedValue(new StorageError("permission_denied", "EACCES"));

        const result = await deleteFileRequestAction(REQUEST, true);

        expect(result.error).toContain("could not be deleted");
        expect(result.error).not.toContain("no folder of its own");
        expect(deleteForOwner).not.toHaveBeenCalled();
    });

    it("does not delete anything for someone who may not write there", async () => {
        authorizeDrive.mockRejectedValue(new DriveAccessError("no"));

        expect(await deleteFileRequestAction(REQUEST, true)).toEqual({
            error: "You cannot delete that folder"
        });
        expect(driverDelete).not.toHaveBeenCalled();
        expect(deleteForOwner).not.toHaveBeenCalled();
    });

    it("still deletes the drop point when its folder is already gone", async () => {
        driverDelete.mockRejectedValue(new StorageError("not_found", "no such folder"));

        expect(await deleteFileRequestAction(REQUEST, true)).toEqual({});
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, REQUEST);
    });

    it("still deletes the drop point when the local disk says the folder is not there", async () => {
        // The local driver's delete hands Node's own error back rather than a
        // not_found, and that reached the screen as "ENOENT: no such file".
        driverDelete.mockRejectedValue(
            Object.assign(new Error("ENOENT: no such file or directory, rm"), { code: "ENOENT" })
        );

        expect(await deleteFileRequestAction(REQUEST, true)).toEqual({});
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, REQUEST);
    });

    it("asks the backend whether the folder is there when the delete fails another way", async () => {
        driverDelete.mockRejectedValue(new StorageError("io_error", "the server said 500"));
        driverStat.mockRejectedValue(new StorageError("not_found", "nothing here"));

        expect(await deleteFileRequestAction(REQUEST, true)).toEqual({});
        expect(driverStat).toHaveBeenCalledWith(FOLDER);
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, REQUEST);
    });

    it("keeps the failure when the folder is still there after it", async () => {
        driverDelete.mockRejectedValue(new StorageError("io_error", "the server said 500"));

        const result = await deleteFileRequestAction(REQUEST, true);

        expect(result.error).toContain("could not be deleted");
        expect(deleteForOwner).not.toHaveBeenCalled();
    });

    it("says so when the drop point is not the caller's, and touches no storage", async () => {
        getForOwner.mockResolvedValue(null);

        expect(await deleteFileRequestAction(REQUEST, true)).toEqual({
            error: "That drop point no longer exists."
        });
        expect(driverDelete).not.toHaveBeenCalled();
        expect(deleteForOwner).not.toHaveBeenCalled();
    });
});

describe("a drop point that collects into the connection itself", () => {
    it("deletes the drop point and leaves the connection alone", async () => {
        getForOwner.mockResolvedValue({
            id: REQUEST,
            destinationConnectionId: CONNECTION,
            destinationPath: ""
        });

        // The dialog does not offer the folder for one of these, so this is a stale
        // client asking. There is no folder of its own to take - only every other
        // folder on the connection, which is not what the choice ever meant.
        const result = await deleteFileRequestAction(REQUEST, true);

        expect(result.error).toContain("no folder of its own");
        expect(driverDelete).not.toHaveBeenCalled();
        // Answered from the destination itself, so no driver is opened to be told.
        expect(authorizeDrive).not.toHaveBeenCalled();
        expect(deleteForOwner).not.toHaveBeenCalled();
    });

    it("deletes cleanly when the folder was not asked for", async () => {
        getForOwner.mockResolvedValue({
            id: REQUEST,
            destinationConnectionId: CONNECTION,
            destinationPath: ""
        });

        expect(await deleteFileRequestAction(REQUEST, false)).toEqual({});
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, REQUEST);
        expect(driverDelete).not.toHaveBeenCalled();
    });
});

describe("deleting several drop points at once", () => {
    const A = "018f2b7a-0000-7000-8000-0000000000c1";
    const B = "018f2b7a-0000-7000-8000-0000000000c2";
    const ROOT = "018f2b7a-0000-7000-8000-0000000000c3";

    beforeEach(() => {
        getForOwner.mockImplementation(async (_owner: string, id: string) => ({
            id,
            destinationConnectionId: CONNECTION,
            destinationPath: id === ROOT ? "" : `Drop Points/${id}`
        }));
    });

    it("deletes each with its folder, and keeps the one whose folder would not go", async () => {
        driverDelete.mockImplementation(async (path: string) => {
            if (path === `Drop Points/${B}`) throw new StorageError("io_error", "share offline");
        });

        const result = await deleteFileRequestsAction([A, B, ROOT], true);

        expect(result.deleted).toEqual([A, ROOT]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.id).toBe(B);
        expect(result.failed[0]?.error).toContain("could not be deleted");
        // One with no folder of its own is deleted without one, not refused, and
        // the connection itself is never touched.
        expect(driverDelete).not.toHaveBeenCalledWith("", expect.anything());
        expect(deleteForOwner).toHaveBeenCalledWith(OWNER, ROOT);
        expect(deleteForOwner).not.toHaveBeenCalledWith(OWNER, B);
    });

    it("leaves every folder alone when the choice is off", async () => {
        const result = await deleteFileRequestsAction([A, B], false);
        expect(result.deleted).toEqual([A, B]);
        expect(driverDelete).not.toHaveBeenCalled();
    });

    it("treats folders that are already gone as done", async () => {
        driverDelete.mockRejectedValue(
            Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
        );
        const result = await deleteFileRequestsAction([A, B], true);
        expect(result.deleted).toEqual([A, B]);
        expect(result.failed).toEqual([]);
    });

    it("refuses a list that is not a list of drop point ids", async () => {
        const result = await deleteFileRequestsAction(["../etc"], true);
        expect(result.deleted).toEqual([]);
        expect(result.error).toBeTruthy();
        expect(getForOwner).not.toHaveBeenCalled();
        expect((await deleteFileRequestsAction([], true)).error).toBeTruthy();
    });
});
