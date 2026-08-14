/**
 * What a delete is not allowed to reach.
 *
 * Polaris keeps the recycle bin and the quarantine in one hidden folder at a
 * connection's root, and every listing the browser draws filters it out - so the
 * only way anything ever arrives at it is a delete that recursed into it from the
 * root, or a caller naming it by hand. The first destroyed the copies a delete is
 * supposed to be recoverable from; the second is a visitor guessing at the one path
 * they were never shown. Both are refused here, in the one place every delete goes
 * through.
 */

import { describe, expect, it, vi } from "vitest";
import { StorageError, type StorageDriver } from "@polaris/storage";
import { deletableChildren, deleteDriveEntry } from "../../src/lib/drive-delete";

/** Just enough driver to see what a delete would have done. */
function driver() {
    const remove = vi.fn(async () => undefined);
    return { remove, driver: { delete: remove } as unknown as StorageDriver };
}

describe("deleting an entry from a connection", () => {
    it("deletes an ordinary folder and everything under it", async () => {
        const { remove, driver: fake } = driver();

        await deleteDriveEntry(fake, "Drop Points/Photos");

        expect(remove).toHaveBeenCalledWith("Drop Points/Photos", { recursive: true });
    });

    it("refuses the connection root, which is every folder on it at once", async () => {
        const { remove, driver: fake } = driver();

        await expect(deleteDriveEntry(fake, "")).rejects.toThrow(StorageError);
        await expect(deleteDriveEntry(fake, "/")).rejects.toThrow(StorageError);
        expect(remove).not.toHaveBeenCalled();
    });

    it("refuses Polaris's own folder, which holds the bin the delete undoes from", async () => {
        const { remove, driver: fake } = driver();

        await expect(deleteDriveEntry(fake, ".polaris")).rejects.toThrow(StorageError);
        // The pre-consolidation locations are reserved too, so leftovers stay put.
        await expect(deleteDriveEntry(fake, ".polaris-trash")).rejects.toThrow(StorageError);
        await expect(deleteDriveEntry(fake, ".polaris-quarantine")).rejects.toThrow(StorageError);
        expect(remove).not.toHaveBeenCalled();
    });

    it("refuses the bin and the quarantine inside it, named directly", async () => {
        // The path a share visitor can hand to the public delete route, and the one
        // worth the most to them: hiding the folder is no protection if its contents
        // can be asked for by name.
        const { remove, driver: fake } = driver();

        await expect(deleteDriveEntry(fake, ".polaris/trash")).rejects.toThrow(StorageError);
        await expect(deleteDriveEntry(fake, ".polaris/quarantine")).rejects.toThrow(StorageError);
        await expect(deleteDriveEntry(fake, ".polaris/trash/abc-photo.jpg")).rejects.toThrow(
            StorageError
        );
        await expect(deleteDriveEntry(fake, ".polaris-trash/abc")).rejects.toThrow(StorageError);
        expect(remove).not.toHaveBeenCalled();
    });

    it("reports the refusal as a permission, not as storage having failed", async () => {
        const { driver: fake } = driver();

        await expect(deleteDriveEntry(fake, ".polaris")).rejects.toMatchObject({
            code: "permission_denied"
        });
    });

    it("lets through a folder that only looks reserved further down", async () => {
        // Only the root holds one, so a folder of that name inside somebody's work is
        // theirs and comes out with the rest.
        const { remove, driver: fake } = driver();

        await deleteDriveEntry(fake, "Archive/.polaris");

        expect(remove).toHaveBeenCalledWith("Archive/.polaris", { recursive: true });
    });
});

describe("the children a folder is emptied of", () => {
    it("keeps everything the reader can see", () => {
        expect(deletableChildren(["Photos", "Invoices/2026", "notes.md"])).toEqual([
            "Photos",
            "Invoices/2026",
            "notes.md"
        ]);
    });

    it("leaves Polaris's own folder in place", () => {
        expect(deletableChildren(["Photos", ".polaris", ".polaris-trash"])).toEqual(["Photos"]);
    });

    it("leaves what is inside it in place too, when that folder is the one being emptied", () => {
        expect(deletableChildren([".polaris/trash", ".polaris/quarantine"])).toEqual([]);
    });

    it("normalizes what it returns, so a leading slash is not a different path", () => {
        expect(deletableChildren(["/Photos", "./Invoices"])).toEqual(["Photos", "Invoices"]);
    });
});
