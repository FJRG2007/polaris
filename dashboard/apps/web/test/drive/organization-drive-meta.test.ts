/**
 * What a company's shelf does to the code that assumed a drive has an owner.
 *
 * Every one of these was a screen that offered something and then refused it.
 * An organization's Drive belongs to no account, so `ownerId === user.id` - the
 * question the whole of Drive was built on - answers no for the organization's
 * own owner, for every member of it and for an instance administrator alike.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const db = {
    storageConnection: { findUnique: vi.fn() },
    driveItemMeta: { upsert: vi.fn(), findMany: vi.fn() }
};
const canManageDriveConnection = vi.fn();
const mayReadDrive = vi.fn();
const memberOrgIds = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/drive-authz", () => ({ canManageDriveConnection, mayReadDrive }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds }));

const { listFavorites, setItemFavorite } = await import("@/lib/drive-meta-service");

const ORG = "11111111-1111-4111-8111-111111111111";
const SHELF = ORG;
const ADA = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
    vi.clearAllMocks();
    memberOrgIds.mockResolvedValue([ORG]);
    db.driveItemMeta.findMany.mockResolvedValue([]);
    db.driveItemMeta.upsert.mockResolvedValue({});
    db.storageConnection.findUnique.mockResolvedValue({ ownerId: null, orgId: ORG });
    canManageDriveConnection.mockResolvedValue(true);
    mayReadDrive.mockResolvedValue(true);
});

/** A starred row as the query answers it: the shelf it is on, and whether that
 *  shelf belongs to an account or to an organization. */
function star(path: string, ownerId: string | null = null) {
    return {
        connectionId: ownerId === null ? SHELF : "mine",
        path,
        connection: { name: "Acme files", ownerId }
    };
}

describe("customizing an item on a company shelf", () => {
    it("asks whether the account may manage the shelf, not whether it owns one", async () => {
        await setItemFavorite(ADA, SHELF, "legal/contract.pdf", true);
        expect(canManageDriveConnection).toHaveBeenCalledWith(ADA, false, SHELF);
    });

    it("files the row under the organization, which is who the shelf belongs to", async () => {
        await setItemFavorite(ADA, SHELF, "legal/contract.pdf", true);
        expect(db.driveItemMeta.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: expect.objectContaining({ ownerId: ORG }) })
        );
    });

    it("refuses somebody the organization does not let change it", async () => {
        canManageDriveConnection.mockResolvedValue(false);
        await expect(setItemFavorite(ADA, SHELF, "legal/contract.pdf", true)).rejects.toThrow();
        expect(db.driveItemMeta.upsert).not.toHaveBeenCalled();
    });
});

describe("favourites", () => {
    it("looks under the organizations too, or a star there appears for nobody", async () => {
        await listFavorites(ADA);
        expect(db.driveItemMeta.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { ownerId: { in: [ADA, ORG] }, favorite: true }
            })
        );
    });

    it("leaves out what the shelf's own rules do not let this account open", async () => {
        // Being on the roster is what finds a company's stars; it is not what
        // opens them. A folder narrowed by a deny to one team would otherwise
        // have its names and its full paths listed for everybody in the
        // organization, on a screen nothing else gates.
        db.driveItemMeta.findMany.mockResolvedValue([
            star("legal/settlement.pdf"),
            star("shared/notes.md")
        ]);
        mayReadDrive.mockImplementation(
            async (_userId: string, _connectionId: string, path: string) =>
                !path.startsWith("legal/")
        );

        expect((await listFavorites(ADA)).map((item) => item.path)).toEqual(["shared/notes.md"]);
        expect(mayReadDrive).toHaveBeenCalledWith(ADA, SHELF, "legal/settlement.pdf");
    });

    it("asks nothing of a drive this account owns", async () => {
        // The row is under this account because the connection is, which the
        // query already established - a second resolution per star would be a
        // page of queries answering a question nobody asked.
        db.driveItemMeta.findMany.mockResolvedValue([star("holiday.jpg", ADA)]);

        expect((await listFavorites(ADA)).map((item) => item.path)).toEqual(["holiday.jpg"]);
        expect(mayReadDrive).not.toHaveBeenCalled();
    });
});
