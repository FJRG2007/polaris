/**
 * The rules a transfer has to keep, asserted rather than trusted.
 *
 * Every one of these is a way somebody's Drive could fill with things they did
 * not ask for, or a way a file could be lost between two people. They are the
 * reason this is an offer with an answer rather than a copy with a notification.
 */

import { StorageError } from "@polaris/storage";
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
const blockedBetween = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/blocks", () => ({ blockedBetween }));
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
vi.mock("@/lib/drive-meta-service", () => ({ recordItemCreator: vi.fn(async () => undefined) }));
vi.mock("@/lib/drive-authz", () => ({
    requireDriveDriver,
    DriveAccessError: class extends Error {}
}));

const {
    acceptTransfer,
    sendTransfer,
    mayReceiveFrom,
    transfersSentBy,
    transfersWaitingFor,
    TransferRefused
} = await import("@/lib/drive-transfer-service");

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
    db.driveTransfer.findMany.mockResolvedValue([]);
    blockedBetween.mockResolvedValue(new Set<string>());
    requireDriveDriver.mockResolvedValue(aFolder);
});

/**
 * The privacy check, as the service uses it: a first pass with nobody counted a
 * friend, and a second for the colleagues that hands them to the same rule as
 * friends of the sender. `settings` says what each account chose, so a test can
 * write "everybody except him" and watch it hold.
 */
function privacyIs(settings: Record<string, "allows" | "friendsOnly" | "refuses">) {
    allowedBy.mockImplementation(
        async (
            _viewer: unknown,
            _field: string,
            ids: readonly string[],
            asFriends?: ReadonlySet<string>
        ) =>
            new Set(
                ids.filter((id) => {
                    const answer = settings[id] ?? "refuses";
                    if (answer === "allows") return true;
                    return answer === "friendsOnly" && (asFriends?.has(id) ?? false);
                })
            )
    );
}

describe("who may be sent a file", () => {
    it("lets a colleague through even when they are not a friend", async () => {
        // Being put in the same organization is somebody with authority over
        // both accounts saying they work together, which is a stronger statement
        // than a friend request.
        privacyIs({ bob: "friendsOnly" });
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organizationMember.findMany.mockResolvedValue([{ userId: "bob" }]);
        expect([...(await mayReceiveFrom("me", ["bob"]))]).toEqual(["bob"]);
    });

    it("counts the organization's owner, who is never a member row", async () => {
        // Otherwise the one account that answers for a company is the one
        // nobody in it can send anything to.
        privacyIs({ ada: "friendsOnly" });
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organization.findMany.mockResolvedValue([{ ownerId: "ada" }]);
        expect([...(await mayReceiveFrom("me", ["ada"]))]).toEqual(["ada"]);
    });

    it("still means nobody when somebody said nobody", async () => {
        // The widening is of `friends`, never of `nobody`. An account that shut
        // the door stays shut to the people it works with too.
        privacyIs({ bob: "refuses" });
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organizationMember.findMany.mockResolvedValue([{ userId: "bob" }]);
        expect([...(await mayReceiveFrom("me", ["bob"]))]).toEqual([]);
    });

    it("keeps a colleague the recipient named as an exception out", async () => {
        // "Everybody except him" and "only these two" are decisions somebody
        // made on purpose, and sharing an organization is not a way around
        // either. The colleagues are handed back to the same rule as friends of
        // the sender rather than added to its answer, so an audience that names
        // the sender still refuses them.
        privacyIs({ bob: "refuses" });
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organizationMember.findMany.mockResolvedValue([{ userId: "bob" }]);
        expect([...(await mayReceiveFrom("me", ["bob"]))]).toEqual([]);
        // And it was asked as a friend, which is the whole of the widening.
        expect(allowedBy).toHaveBeenLastCalledWith(
            { id: "me", isAdmin: false },
            "fileTransfers",
            ["bob"],
            new Set(["bob"])
        );
    });

    it("never counts the sender themselves", async () => {
        expect([...(await mayReceiveFrom("me", ["me"]))]).toEqual([]);
    });

    it("keeps a block out, in either direction and past every widening", async () => {
        // A block holds wherever one account can reach another, and neither door
        // above closes on it: blocking a friend does not end the friendship, and
        // being colleagues does not either.
        privacyIs({ bob: "friendsOnly", ada: "allows" });
        memberOrgIds.mockResolvedValue(["org1"]);
        db.organizationMember.findMany.mockResolvedValue([{ userId: "bob" }]);
        blockedBetween.mockResolvedValue(new Set(["bob", "ada"]));
        expect([...(await mayReceiveFrom("me", ["bob", "ada"]))]).toEqual([]);
    });
});

describe("what is waiting to be answered", () => {
    it("asks for no organization when the account administers none", async () => {
        // The id is a Postgres uuid, and a sentinel that is not one raises
        // instead of matching nothing - which took every offer made to the
        // person with it, for everybody not running an organization's Drive.
        memberOrgIds.mockResolvedValue([]);
        await transfersWaitingFor("me");
        const where = db.driveTransfer.findMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([{ recipientId: "me" }]);
    });

    it("asks for the organizations it may answer for when there are some", async () => {
        memberOrgIds.mockResolvedValue(["org1", "org2"]);
        resolveOrgAccess.mockImplementation(async (_actor: unknown, orgId: string) =>
            orgId === "org1" ? { permissions: ["drive.manage"] } : { permissions: ["org.read"] }
        );
        await transfersWaitingFor("me");
        const where = db.driveTransfer.findMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([{ recipientId: "me" }, { recipientOrg: { in: ["org1"] } }]);
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

    it("counts what is waiting for THESE recipients and nobody else", async () => {
        // An empty object inside an `OR` is an empty filter and matches every
        // row, so a ceiling written per recipient counted every offer this
        // account had out anywhere - twenty people answered by nobody made a
        // twenty-first impossible to write to.
        allowedBy.mockResolvedValue(new Set(["bob"]));
        await sendTransfer({
            senderId: "me",
            connectionId: "c1",
            path: "a/b.txt",
            mode: "copy",
            to: [{ userId: "bob" }]
        });
        expect(db.driveTransfer.count).toHaveBeenCalledWith({
            where: {
                senderId: "me",
                status: "pending",
                OR: [{ recipientId: { in: ["bob"] } }]
            }
        });
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

describe("answering an offer", () => {
    const offer = {
        id: "t1",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        senderId: "ada",
        connectionId: "c1",
        path: "a/b.txt",
        name: "b.txt",
        isFolder: false,
        mode: "copy",
        recipientId: "bob",
        recipientOrg: null
    };

    /** A drive with nothing in it: every name asked about is free, which is what
     *  `not_found` means and the only thing that means it. */
    function anEmptyDrive(overrides: Record<string, unknown> = {}) {
        return {
            stat: vi.fn(async () => {
                throw new StorageError("not_found", "not there");
            }),
            readStream: vi.fn(async () => "bytes"),
            writeStream: vi.fn(async () => undefined),
            mkdir: vi.fn(async () => undefined),
            list: vi.fn(async () => ({ entries: [], nextCursor: undefined })),
            delete: vi.fn(async () => undefined),
            dispose: vi.fn(async () => undefined),
            ...overrides
        };
    }

    beforeEach(async () => {
        const { ensurePersonalDrive } = await import("@/lib/personal-drive");
        vi.mocked(ensurePersonalDrive).mockResolvedValue({ id: "mine" } as never);
        db.driveTransfer.findUnique.mockResolvedValue(offer);
        db.driveTransfer.updateMany.mockResolvedValue({ count: 1 });
        db.driveTransfer.update.mockResolvedValue({});
        requireDriveDriver.mockResolvedValue(anEmptyDrive());
    });

    it("claims the offer before it copies anything", async () => {
        // Two people answering the same organization's offer, or one person in
        // two tabs, would otherwise both pass the pending check and both copy -
        // the second landing beside the first under a suffix.
        await acceptTransfer("t1", "bob");
        expect(db.driveTransfer.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "t1", status: "pending" },
                data: expect.objectContaining({ status: "accepting" })
            })
        );
    });

    it("refuses the second answer, having lost the claim", async () => {
        db.driveTransfer.updateMany.mockResolvedValue({ count: 0 });
        await expect(acceptTransfer("t1", "bob")).rejects.toThrow(/already been answered/i);
    });

    it("opens the destination through the door every other write goes through", async () => {
        // The folder it lands in came from a browser. Taking a bare driver here
        // would put a file somewhere an explicit deny or an access lock holds
        // shut - on a company shelf, and on the person's own Drive too.
        await acceptTransfer("t1", "bob", "legal");
        expect(requireDriveDriver).toHaveBeenCalledWith("bob", "mine", "legal", "write");
    });

    it("refuses a folder that climbs out of the drive, with the offer left standing", async () => {
        // A path from a browser is a claim like any other. Worked out before the
        // claim below, because a throw after it leaves the row `accepting`:
        // gone from what is waiting to be answered, gone from what the sender
        // can take back, and answerable by nobody for six hours.
        await expect(acceptTransfer("t1", "bob", "../elsewhere")).rejects.toBeInstanceOf(
            TransferRefused
        );
        expect(db.driveTransfer.updateMany).not.toHaveBeenCalled();
        expect(db.driveTransfer.update).not.toHaveBeenCalled();
    });

    it("will not take a name whose storage would not answer for one that is free", async () => {
        // A permissions failure or a dropped link is not "there is nothing
        // here". Read as a free name, the copy lands on top of the very file
        // nobody could see - which is the one thing this must never do.
        requireDriveDriver.mockResolvedValue(
            anEmptyDrive({
                stat: vi.fn(async () => {
                    throw new StorageError("permission_denied", "not permitted");
                })
            })
        );
        await expect(acceptTransfer("t1", "bob")).rejects.toBeInstanceOf(TransferRefused);
        expect(db.driveTransfer.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })
        );
    });

    it("takes the half that landed back out when a copy fails part way", async () => {
        // `freeName` had just established the name was nobody's, so what is
        // under it is this copy and nothing else. Left there it is a folder in
        // somebody's Drive under a name they never chose, that no screen
        // mentions and that no retry would ever clear.
        const target = anEmptyDrive({
            writeStream: vi.fn(async () => {
                throw new Error("the link dropped");
            })
        });
        requireDriveDriver.mockResolvedValue(target);
        await expect(acceptTransfer("t1", "bob")).rejects.toBeInstanceOf(TransferRefused);
        expect(target.delete).toHaveBeenCalledWith("b.txt", { recursive: true });
    });
});

describe("telling the sender", () => {
    it("keeps an answered transfer in front of them while it carries a failure", async () => {
        // A move whose copy landed but whose delete failed leaves them holding a
        // duplicate of a file they asked to give away, and it leaves the waiting
        // list without a word. This is the only place they would ever learn it.
        db.driveTransfer.findMany.mockResolvedValue([]);
        await transfersSentBy("ada");
        expect(db.driveTransfer.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    senderId: "ada",
                    OR: [{ status: "pending" }, { failure: { not: null } }]
                })
            })
        );
    });
});
