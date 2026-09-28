/**
 * Creating and renaming are cleared on the folder the item actually lands in.
 *
 * The name arrives from the browser and is joined onto the folder before it is
 * normalized, so "../private/payroll.xlsx" typed into a folder somebody may write
 * in resolves to a folder they may not - and creating a file there truncates
 * whatever was already at that path. A rename is a move when the new path is in
 * another folder, and a move takes the right to write at the destination. Both
 * are pinned here against the path the write really touches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION = "018f2b7a-0000-7000-8000-0000000000e1";

const writeStream = vi.fn(async () => undefined);
const mkdir = vi.fn(async () => undefined);
const move = vi.fn(async () => undefined);
const stat = vi.fn(async (): Promise<unknown> => {
    throw new Error("missing");
});
const dispose = vi.fn(async () => undefined);

const requireDriveDriver = vi.fn(async (..._args: unknown[]) => ({ writeStream, mkdir, move, stat, dispose }));
const authorizeDrive = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "u1", isAdmin: false }),
    requirePermission: async () => ({ id: "u1", isAdmin: false })
}));
vi.mock("@/lib/drive-authz", () => ({
    authorizeDrive: (...args: unknown[]) => authorizeDrive(...args),
    authorizeDrivePaths: async () => undefined,
    requireDriveDriver: (...args: unknown[]) => requireDriveDriver(...args),
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {}
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: async () => undefined }));
vi.mock("@/lib/drive-meta-service", () => ({
    moveItemMeta: async () => undefined,
    recordItemCreator: async () => undefined,
    setItemFavorite: async () => undefined,
    setItemHidden: async () => undefined,
    setItemIcon: async () => undefined,
    setItemNote: async () => undefined
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const actions = await import("../../src/app/(app)/drive/actions");

beforeEach(() => {
    vi.clearAllMocks();
});

describe("creating", () => {
    it("clears a file on the folder its name resolves into", async () => {
        await actions.createFileAction(CONNECTION, "shared", "../private/payroll.xlsx");
        expect(requireDriveDriver).toHaveBeenCalledWith("u1", CONNECTION, "private", "write");
        expect(requireDriveDriver).not.toHaveBeenCalledWith("u1", CONNECTION, "shared", "write");
    });

    it("clears a folder the same way", async () => {
        await actions.mkdirAction(CONNECTION, "shared", "../private/planted");
        expect(requireDriveDriver).toHaveBeenCalledWith("u1", CONNECTION, "private", "write");
    });

    it("still clears a plain name on the folder it was made in", async () => {
        await actions.createFileAction(CONNECTION, "shared", "notes.txt");
        expect(requireDriveDriver).toHaveBeenCalledWith("u1", CONNECTION, "shared", "write");
        expect(writeStream).toHaveBeenCalledWith("shared/notes.txt", expect.anything(), {});
    });

    it("writes nothing when the folder it lands in is refused", async () => {
        requireDriveDriver.mockRejectedValueOnce(new Error("You cannot write here"));
        const result = await actions.createFileAction(CONNECTION, "shared", "../private/payroll.xlsx");
        expect(result.error).toBeTruthy();
        expect(writeStream).not.toHaveBeenCalled();
    });
});

describe("renaming", () => {
    it("takes the right to write where it lands when that is another folder", async () => {
        await actions.renameAction(CONNECTION, "shared/a.txt", "private/a.txt");
        expect(authorizeDrive).toHaveBeenCalledWith("u1", CONNECTION, "private", "write");
    });

    it("moves nothing when the destination folder is refused", async () => {
        authorizeDrive.mockRejectedValueOnce(new Error("You cannot write here"));
        const result = await actions.renameAction(CONNECTION, "shared/a.txt", "private/a.txt");
        expect(result.error).toBeTruthy();
        expect(move).not.toHaveBeenCalled();
    });

    it("asks nothing more of a rename that stays in its folder", async () => {
        await actions.renameAction(CONNECTION, "shared/a.txt", "shared/b.txt");
        expect(authorizeDrive).not.toHaveBeenCalled();
        expect(move).toHaveBeenCalledWith("shared/a.txt", "shared/b.txt");
    });
});
