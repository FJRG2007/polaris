/**
 * An upload is authorized on the folder the file actually lands in.
 *
 * The file's `name` is joined onto `p` and normalized, so a name carrying `../`
 * or a nested path puts the write somewhere other than `p`. Checking `p` let
 * somebody given one folder write - or overwrite - anywhere on the storage, past
 * the per-folder rules and the locks on it.
 */

import { StorageError } from "@polaris/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeDrive = vi.fn();
const getDriverForConnection = vi.fn();
const writeStream = vi.fn(async (path: string) => ({ path, size: 1n }));

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "writer-1", isAdmin: false }) }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => true }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/drive-meta-service", () => ({ recordItemCreator: async () => undefined }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: async () => undefined }));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {},
    authorizeDrive
}));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection }));

const route = await import("../../src/app/api/drive/upload/route");

function upload(p: string, name: string): Promise<Response> {
    const query = new URLSearchParams({ c: "conn-1", p, name });
    return route.PUT(
        new Request(`https://polaris.test/api/drive/upload?${query}`, { method: "PUT", body: "x" })
    );
}

beforeEach(() => {
    authorizeDrive.mockReset();
    authorizeDrive.mockResolvedValue(undefined);
    getDriverForConnection.mockReset();
    getDriverForConnection.mockResolvedValue({
        id: "conn-1",
        mkdir: async () => undefined,
        // Nothing is there yet, so the name is free to take.
        stat: async (path: string) => {
            throw new StorageError("not_found", path);
        },
        delete: async () => undefined,
        writeStream,
        dispose: async () => undefined
    });
    writeStream.mockClear();
});

describe("a drive upload", () => {
    it("is checked against the folder a ../ name escapes to", async () => {
        await upload("team/inbox", "../../hr/payroll.xlsx");
        expect(authorizeDrive).toHaveBeenCalledWith("writer-1", "conn-1", "hr", "write");
        expect(writeStream.mock.calls[0]?.[0]).toBe("hr/payroll.xlsx");
    });

    it("is checked against the deepest folder of a nested folder upload", async () => {
        await upload("team/inbox", "album/2026/photo.jpg");
        expect(authorizeDrive).toHaveBeenCalledWith(
            "writer-1",
            "conn-1",
            "team/inbox/album/2026",
            "write"
        );
    });

    it("writes nothing when that folder is refused", async () => {
        const { DriveAccessError } = await import("@/lib/drive-authz");
        authorizeDrive.mockRejectedValue(new DriveAccessError());
        const answer = await upload("team/inbox", "../../hr/payroll.xlsx");
        expect(answer.status).toBe(403);
        expect(getDriverForConnection).not.toHaveBeenCalled();
        expect(writeStream).not.toHaveBeenCalled();
    });
});
