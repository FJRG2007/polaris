/**
 * The dashboard's half of a Drive file on a CRM record: a file is pointed at
 * only after the reader's Drive access is checked, never a folder, and a file
 * the reader lost access to drops out of the list instead of being named.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const mocks = vi.hoisted(() => ({
    driver: {
        stat: vi.fn(async (): Promise<unknown> => ({ kind: "file" })),
        dispose: vi.fn(async () => undefined)
    },
    requireDriveDriver: vi.fn(),
    mayReadDrive: vi.fn(async () => true),
    prisma: {
        storageConnection: { findUnique: vi.fn(async () => ({ ownerId: "u1", orgId: null })) },
        driveItemMeta: {
            upsert: vi.fn(async () => ({ id: "meta-1" })),
            findMany: vi.fn(async (): Promise<unknown[]> => [])
        }
    }
}));

vi.mock("@polaris/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/drive-authz", () => ({
    requireDriveDriver: mocks.requireDriveDriver,
    mayReadDrive: mocks.mayReadDrive
}));
vi.mock("@/lib/workspace-scope", () => ({ resolveScope: vi.fn() }));
vi.mock("@/lib/orgs/org-service", () => ({
    listOrgMembers: vi.fn(),
    orgCan: vi.fn(),
    resolveOrgAccess: vi.fn()
}));

import { crmDriveFileRef, crmDriveFiles } from "@/lib/crm-host";

const actor = { id: "u1", isAdmin: false };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDriveDriver.mockResolvedValue(mocks.driver);
});

describe("crmDriveFileRef", () => {
    it("checks Drive access, then keeps the file's own entry", async () => {
        expect(await crmDriveFileRef(actor, CONNECTION, "/decks/deck.pdf")).toEqual({
            id: "meta-1",
            name: "deck.pdf"
        });
        expect(mocks.requireDriveDriver).toHaveBeenCalledWith(
            "u1",
            CONNECTION,
            "decks/deck.pdf",
            "read",
            {
                skipLock: true
            }
        );
        expect(mocks.prisma.driveItemMeta.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { connectionId_path: { connectionId: CONNECTION, path: "decks/deck.pdf" } }
            })
        );
        expect(mocks.driver.dispose).toHaveBeenCalled();
    });

    it("refuses a file the reader cannot read, a folder, and a path out of the root", async () => {
        mocks.requireDriveDriver.mockRejectedValueOnce(new Error("no"));
        expect(await crmDriveFileRef(actor, CONNECTION, "secret.pdf")).toEqual({ refused: true });
        mocks.driver.stat.mockResolvedValueOnce({ kind: "dir" });
        expect(await crmDriveFileRef(actor, CONNECTION, "decks")).toEqual({ refused: true });
        expect(await crmDriveFileRef(actor, CONNECTION, "../../etc/passwd")).toEqual({
            refused: true
        });
        expect(await crmDriveFileRef(actor, "not-a-uuid", "deck.pdf")).toEqual({ refused: true });
        expect(mocks.prisma.driveItemMeta.upsert).not.toHaveBeenCalled();
    });
});

describe("crmDriveFiles", () => {
    it("names only the files the reader may still read, in the order asked", async () => {
        mocks.prisma.driveItemMeta.findMany.mockResolvedValueOnce([
            { id: "a", connectionId: CONNECTION, path: "x/one.pdf" },
            { id: "b", connectionId: CONNECTION, path: "two.pdf" }
        ]);
        mocks.mayReadDrive.mockImplementation(async (...args: unknown[]) => args[2] !== "two.pdf");
        expect(await crmDriveFiles(actor, ["b", "a", "gone"])).toEqual([
            {
                id: "a",
                name: "one.pdf",
                href: `/drive/open?c=${CONNECTION}&p=x%2Fone.pdf`
            }
        ]);
    });
});
