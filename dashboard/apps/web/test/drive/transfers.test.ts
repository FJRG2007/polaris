/**
 * The rules a transfer has to keep, asserted rather than trusted.
 *
 * Every one of these is a way somebody's Drive could fill with things they did
 * not ask for, or a way a file could be lost between two people. They are the
 * reason this is an offer with an answer rather than a copy with a notification.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const db = {
    driveTransfer: {
        count: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn()
    },
    userPrivacy: { findMany: vi.fn() },
    organizationMember: { findMany: vi.fn() },
    organization: { findMany: vi.fn() }
};
const allowedBy = vi.fn();
const memberOrgIds = vi.fn();
const resolveOrgAccess = vi.fn();
const requireDriveDriver = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/privacy-service", () => ({ allowedBy }));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds,
    resolveOrgAccess,
    orgCan: (access: unknown, permission: string) =>
        access !== null &&
        (access as { permissions: string[] }).permissions.some(
            (held) => held === "*" || held === permission
        )
}));
vi.mock("@/lib/personal-drive", () => ({ ensurePersonalDrive: vi.fn() }));
vi.mock("@/lib/organization-drive", () => ({ ensureOrganizationDrive: vi.fn() }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: vi.fn() }));
vi.mock("@/lib/drive-meta-service", () => ({ recordItemCreator: vi.fn() }));
vi.mock("@/lib/drive-authz", () => ({
    requireDriveDriver,
    DriveAccessError: class extends Error {}
}));

const { sendTransfer, mayReceiveFrom, TransferRefused } = await import(
    "@/lib/drive-transfer-service"
);

const aFolder = {
    stat: vi.fn(async () => ({ kind: "dir" as const, size: 10n })),
    dispose: vi.fn(async () => undefined)
};

beforeEach(() => {
    vi.clearAllMocks();
    allowedBy.mockResolvedValue(new Set<string>());
    memberOrgIds.mockResolvedValue([]);
    db.userPrivacy.findMany.mockResolvedValue([]);
    db.organizationMember.findMany.mockResolvedValue([]);
    db.organization.findMany.mockResolvedValue([]);
    db.driveTransfer.count.mockResolvedValue(0);
    db.driveTransfer.create.mockResolvedValue({ id: "t1" });
    requireDriveDriver.mockResolvedValue(aFolder);
});

describe("who may be sent a file", () => {
    it("lets a colleague through even when they are not a friend", async () => {
        // Being put in the same organization is somebody with authority over
        // both accounts saying they work together, which is a stronger statement
        // than a friend request.
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organizationMember.findMany.mockResolvedValue([{ userId: "bob" }]);
        expect([...(await mayReceiveFrom("me", ["bob"]))]).toEqual(["bob"]);
    });

    it("counts the organization's owner, who is never a member row", async () => {
        // Otherwise the one account that answers for a company is the one
        // nobody in it can send anything to.
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organization.findMany.mockResolvedValue([{ ownerId: "ada" }]);
        expect([...(await mayReceiveFrom("me", ["ada"]))]).toEqual(["ada"]);
    });

    it("still means nobody when somebody said nobody", async () => {
        // The widening is of `friends`, never of `nobody`. An account that shut
        // the door stays shut to the people it works with too.
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organizationMember.findMany.mockResolvedValue([{ userId: "bob" }]);
        db.userPrivacy.findMany.mockResolvedValue([{ userId: "bob", fileTransfers: "nobody" }]);
        expect([...(await mayReceiveFrom("me", ["bob"]))]).toEqual([]);
    });

    it("never counts the sender themselves", async () => {
        expect([...(await mayReceiveFrom("me", ["me"]))]).toEqual([]);
    });
});

describe("offering something", () => {
    it("refuses a recipient who has not allowed it, without saying which", async () => {
        // Deliberately the same sentence whether they said no or do not exist:
        // "that account does not accept files from you" tells a stranger both
        // that the account is there and what its setting is.
        await expect(
            sendTransfer({
                senderId: "me",
                connectionId: "c1",
                path: "a/b.txt",
                mode: "copy",
                to: [{ userId: "bob" }]
            })
        ).rejects.toBeInstanceOf(TransferRefused);
        expect(db.driveTransfer.create).not.toHaveBeenCalled();
    });

    it("refuses to send the file itself to several people at once", async () => {
        // "Move it to all of them" has no meaning, and the one thing worse than
        // refusing it is doing something arbitrary.
        allowedBy.mockResolvedValue(new Set(["bob", "ada"]));
        await expect(
            sendTransfer({
                senderId: "me",
                connectionId: "c1",
                path: "a/b.txt",
                mode: "move",
                to: [{ userId: "bob" }, { userId: "ada" }]
            })
        ).rejects.toThrow(/one recipient/i);
    });

    it("asks to delete, not merely to read, before offering to move", async () => {
        // A move ends with the sender's copy being removed, so the standing to
        // remove it is established when the offer is made rather than when it is
        // accepted - by which time the sender may not be looking.
        allowedBy.mockResolvedValue(new Set(["bob"]));
        await sendTransfer({
            senderId: "me",
            connectionId: "c1",
            path: "a/b.txt",
            mode: "move",
            to: [{ userId: "bob" }]
        });
        expect(requireDriveDriver).toHaveBeenCalledWith("me", "c1", "a/b.txt", "delete");
    });

    it("checks the sender may read it at all, through the usual door", async () => {
        // So a folder somebody was merely shown cannot be forwarded out of
        // another person's drive by naming its path here.
        allowedBy.mockResolvedValue(new Set(["bob"]));
        await sendTransfer({
            senderId: "me",
            connectionId: "c1",
            path: "a/b.txt",
            mode: "copy",
            to: [{ userId: "bob" }]
        });
        expect(requireDriveDriver).toHaveBeenCalledWith("me", "c1", "a/b.txt", "download");
    });

    it("records what it is and how big, so the answer is informed", async () => {
        allowedBy.mockResolvedValue(new Set(["bob"]));
        await sendTransfer({
            senderId: "me",
            connectionId: "c1",
            path: "a/photos",
            mode: "copy",
            note: "  the holiday  ",
            to: [{ userId: "bob" }]
        });
        expect(db.driveTransfer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    name: "photos",
                    isFolder: true,
                    size: 10n,
                    mode: "copy",
                    note: "the holiday",
                    recipientId: "bob",
                    recipientOrg: null
                })
            })
        );
    });

    it("will not put a hundred offers in front of somebody who answered none", async () => {
        allowedBy.mockResolvedValue(new Set(["bob"]));
        db.driveTransfer.count.mockResolvedValue(20);
        await expect(
            sendTransfer({
                senderId: "me",
                connectionId: "c1",
                path: "a/b.txt",
                mode: "copy",
                to: [{ userId: "bob" }]
            })
        ).rejects.toThrow(/already several waiting/i);
    });

    it("refuses an organization the sender may not write to", async () => {
        resolveOrgAccess.mockResolvedValue({ permissions: ["org.read"] });
        await expect(
            sendTransfer({
                senderId: "me",
                connectionId: "c1",
                path: "a/b.txt",
                mode: "copy",
                to: [{ orgId: "org1" }]
            })
        ).rejects.toThrow(/not somewhere you can send/i);
    });

    it("allows one it may, which is the same permission as changing anything there", async () => {
        resolveOrgAccess.mockResolvedValue({ permissions: ["drive.manage"] });
        await sendTransfer({
            senderId: "me",
            connectionId: "c1",
            path: "a/b.txt",
            mode: "copy",
            to: [{ orgId: "org1" }]
        });
        expect(db.driveTransfer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ recipientOrg: "org1", recipientId: null })
            })
        );
    });
});
