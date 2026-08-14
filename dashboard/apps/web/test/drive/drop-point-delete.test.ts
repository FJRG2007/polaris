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
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "1.2.3.4", hashForLog: () => "h" }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true }),
    resetRateLimit: async () => undefined
}));
vi.mock("@/lib/storage-service", () => ({
    getDriverForConnection: async () => ({ delete: driverDelete, dispose }),
    SmbShareRequiredError: class extends Error {}
}));
vi.mock("@/lib/drive-authz", () => ({ authorizeDrive, DriveAccessError, DriveLockedError }));
vi.mock("@/lib/file-request-service", () => ({
    getFileRequestForOwner: getForOwner,
    deleteFileRequestForOwner: deleteForOwner
}));

const { deleteFileRequestAction } = await import("../../src/app/(app)/drive/request-actions");

beforeEach(() => {
    // clearAllMocks forgets the calls, not the one-off outcomes a case installed,
    // so every mock that a test overrides is put back to its default by hand.
    vi.clearAllMocks();
    deleteForOwner.mockResolvedValue(true);
    driverDelete.mockResolvedValue(undefined);
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
