/**
 * Everybody's own drive.
 *
 * Three things have to hold, and each of them is a bug that would only be found
 * long afterwards if it did not:
 *
 *  - one drive per account, ever. It is provisioned on a page render, so two
 *    tabs open at the same moment must not make two drives and split somebody's
 *    files between them.
 *  - where it landed is recorded, not re-derived. Connecting a NAS next month
 *    must not make Polaris start looking for last month's files on it.
 *  - it is not a storage the instance may use. Every list that offers a place to
 *    put something - an upload destination, a backup, a deployed service's
 *    volume - has to leave it out, or one person's room becomes the instance's
 *    disk.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ANA = "11111111-1111-4111-8111-111111111111";

const findUnique = vi.fn();
const upsert = vi.fn();
const findMany = vi.fn(async () => []);
const findFirst = vi.fn();
const deleteMany = vi.fn(async () => ({ count: 0 }));
const getSetting = vi.fn(async () => null);

vi.mock("@polaris/db", () => ({
    prisma: {
        storageConnection: { findUnique, upsert, findMany, findFirst, deleteMany }
    }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting, setSetting: vi.fn() }));
vi.mock("@/lib/storage-service", () => ({
    PERSONAL_LOCAL_FOLDER: "drive",
    getDriverForConnection: vi.fn()
}));
vi.mock("@/lib/drive-folder-size", () => ({ getCachedFolderSizes: vi.fn(async () => new Map()) }));

const { ensurePersonalDrive, personalDriveId } = await import("../../src/lib/personal-drive");

beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue(null);
    findMany.mockResolvedValue([]);
    getSetting.mockResolvedValue(null);
});

/** What `upsert` was told to create, parsed. */
function created(): { name: string; config: { targetId: string; root: string } } {
    const call = upsert.mock.calls[0]?.[0];
    return { name: call.create.name, config: JSON.parse(call.create.config) };
}

describe("a person's own drive", () => {
    it("is made on the disk Polaris runs on when nothing is connected", async () => {
        upsert.mockImplementation(async (args: { create: { id: string; name: string; config: string } }) => ({
            id: args.create.id,
            name: args.create.name,
            config: args.create.config
        }));

        const drive = await ensurePersonalDrive(ANA);

        expect(drive.targetId).toBe("local");
        expect(created().config.root).toBe(`people/${ANA}`);
        expect(drive.name).toBe("My files");
    });

    it("is made on the NAS when there is one, under one Polaris folder", async () => {
        const nas = "22222222-2222-4222-8222-222222222222";
        findMany.mockResolvedValue([{ id: nas, name: "Attic", kind: "smb" }]);
        upsert.mockImplementation(async (args: { create: { id: string; config: string } }) => ({
            id: args.create.id,
            name: "My files",
            config: args.create.config
        }));

        const drive = await ensurePersonalDrive(ANA);

        expect(drive.targetId).toBe(nas);
        // Everything Polaris keeps on somebody else's disk lives under one name,
        // so an operator looking at the share can tell what is ours.
        expect(drive.root).toBe(`polaris/drive/people/${ANA}`);
    });

    it("is claimed by an id that cannot be raced", async () => {
        upsert.mockImplementation(async (args: { create: { id: string; config: string } }) => ({
            id: args.create.id,
            name: "My files",
            config: args.create.config
        }));

        await ensurePersonalDrive(ANA);

        // A single upsert on a derived key rather than "look, then create": two
        // requests arriving together resolve to the same row instead of two.
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert.mock.calls[0][0].where).toEqual({ id: personalDriveId(ANA) });
    });

    it("keeps the storage it was made on when the setting later moves", async () => {
        // The account's drive already exists on the disk next door; the instance
        // has since been pointed at a NAS.
        findUnique.mockResolvedValue({
            id: ANA,
            ownerId: ANA,
            kind: "personal",
            name: "My files",
            config: JSON.stringify({ kind: "personal", targetId: "local", root: `people/${ANA}` })
        });
        findMany.mockResolvedValue([{ id: "nas", name: "Attic", kind: "smb" }]);

        const drive = await ensurePersonalDrive(ANA);

        expect(drive.targetId).toBe("local");
        expect(upsert).not.toHaveBeenCalled();
    });

    it("refuses to open a row under its id that is not that account's drive", async () => {
        findUnique.mockResolvedValue({
            id: ANA,
            ownerId: "somebody-else",
            kind: "smb",
            name: "Attic",
            config: JSON.stringify({ kind: "smb", host: "nas", share: "files" })
        });

        await expect(ensurePersonalDrive(ANA)).rejects.toThrow();
        expect(upsert).not.toHaveBeenCalled();
    });
});
