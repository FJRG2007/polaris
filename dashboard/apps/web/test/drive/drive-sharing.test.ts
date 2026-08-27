/**
 * Handing a file or folder to somebody.
 *
 * A share is an access rule, so what is worth pinning is where the two differ:
 * the roles a person picks must never be rounded when they are read back, a
 * grant with a date on it must stop applying when that date passes (nothing
 * sweeps the table, so every read has to say so), and neither list may show
 * somebody their own things as if somebody had given them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

const aclFindMany = vi.fn(async () => []);
const aclFindFirst = vi.fn(async () => null);
const aclCreate = vi.fn(async () => ({}));
const aclUpdate = vi.fn(async () => ({}));
const userFindMany = vi.fn(async () => []);
const groupFindMany = vi.fn(async () => []);
const getUserGroupIds = vi.fn(async () => [] as string[]);

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: { bannedAt: null, disabledAt: null },
    prisma: {
        driveAcl: {
            findMany: aclFindMany,
            findFirst: aclFindFirst,
            create: aclCreate,
            update: aclUpdate,
            deleteMany: vi.fn(async () => ({ count: 1 }))
        },
        user: { findMany: userFindMany },
        group: { findMany: groupFindMany }
    }
}));
vi.mock("@polaris/auth", () => ({
    getUserGroupIds,
    resolvePrincipalPolicyStatements: async () => []
}));

const { listSharedByMe, listSharedWithMe, shareRoleActions, shareRoleOf, shareWithPerson } =
    await import("../../src/lib/drive-sharing");

beforeEach(() => {
    vi.clearAllMocks();
    aclFindMany.mockResolvedValue([]);
    aclFindFirst.mockResolvedValue(null);
    getUserGroupIds.mockResolvedValue([]);
    userFindMany.mockResolvedValue([]);
});

function grant(over: Record<string, unknown> = {}) {
    return {
        id: "grant-1",
        connectionId: "conn-1",
        path: "reports/2026",
        principalType: "user",
        principalId: ANA,
        actions: JSON.stringify(shareRoleActions("viewer")),
        note: null,
        expiresAt: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
        connection: { name: "My files", ownerId: BEN },
        ...over
    };
}

describe("what a role means", () => {
    it("reads back as the role it was given", () => {
        expect(shareRoleOf(shareRoleActions("viewer"))).toBe("viewer");
        expect(shareRoleOf(shareRoleActions("editor"))).toBe("editor");
    });

    it("never rounds a hand-written rule up to one", () => {
        // Read and write but not delete is not "can edit", and saying so on the
        // screen where somebody checks who can change their files would be the
        // kind of lie that is only found out afterwards.
        expect(shareRoleOf(["read", "write"])).toBe("custom");
        expect(shareRoleOf(["read"])).toBe("custom");
        expect(shareRoleOf([])).toBe("custom");
    });

    it("lets a viewer take a copy and nothing else", () => {
        expect(shareRoleActions("viewer")).toEqual(["read", "download"]);
        expect(shareRoleActions("editor")).toContain("delete");
    });
});

describe("giving something away", () => {
    it("refuses to give somebody what is already theirs", async () => {
        await expect(
            shareWithPerson({
                connectionId: "conn-1",
                path: "reports",
                principalType: "user",
                principalId: ANA,
                role: "viewer",
                sharedById: ANA
            })
        ).rejects.toThrow();
        expect(aclCreate).not.toHaveBeenCalled();
    });

    it("replaces what somebody already held rather than stacking a second rule", async () => {
        aclFindFirst.mockResolvedValue({ id: "grant-1" } as never);
        await shareWithPerson({
            connectionId: "conn-1",
            path: "reports",
            principalType: "user",
            principalId: BEN,
            role: "editor",
            sharedById: ANA
        });
        expect(aclUpdate).toHaveBeenCalledTimes(1);
        expect(aclCreate).not.toHaveBeenCalled();
    });
});

describe("what has been shared with me", () => {
    it("names the item and whose it is", async () => {
        aclFindMany.mockResolvedValue([grant()] as never);
        userFindMany.mockResolvedValue([{ id: BEN, name: "Ben" }] as never);

        const [item] = await listSharedWithMe(ANA);

        expect(item.name).toBe("2026");
        expect(item.owner.name).toBe("Ben");
        expect(item.role).toBe("viewer");
    });

    it("calls a whole drive by the drive's name", async () => {
        aclFindMany.mockResolvedValue([grant({ path: "" })] as never);
        userFindMany.mockResolvedValue([{ id: BEN, name: "Ben" }] as never);

        expect((await listSharedWithMe(ANA))[0].name).toBe("My files");
    });

    it("leaves out grants that have lapsed, and your own storages", async () => {
        await listSharedWithMe(ANA);
        const where = aclFindMany.mock.calls[0][0].where;

        // Nothing sweeps expired rows, so the query is the only thing that can
        // stop a share given "until Friday" from still opening on Monday.
        expect(JSON.stringify(where.AND)).toContain("expiresAt");
        expect(where.connection).toEqual({ ownerId: { not: ANA } });
    });

    it("counts a grant made to a group the account is in", async () => {
        getUserGroupIds.mockResolvedValue(["group-7"]);
        await listSharedWithMe(ANA);

        expect(aclFindMany.mock.calls[0][0].where.OR).toEqual([
            { principalType: "user", principalId: ANA },
            { principalType: "group", principalId: "group-7" }
        ]);
    });

    it("still names an item whose owner has gone", async () => {
        aclFindMany.mockResolvedValue([grant()] as never);
        userFindMany.mockResolvedValue([]);

        expect((await listSharedWithMe(ANA))[0].owner.name).toBeTruthy();
    });
});

describe("what I have shared", () => {
    it("asks only for rules on my own storages that I wrote", async () => {
        await listSharedByMe(ANA);
        const where = aclFindMany.mock.calls[0][0].where;

        expect(where.connection).toEqual({ ownerId: ANA });
        expect(where.createdById).toBe(ANA);
        // A rule naming yourself is not a share, and an administrator writing
        // one on your storage is their rule, not your share.
        expect(where.NOT).toEqual({ principalType: "user", principalId: ANA });
    });

    it("says who it went to", async () => {
        aclFindMany.mockResolvedValue([
            grant({ principalId: BEN, connection: { name: "My files", ownerId: ANA } })
        ] as never);
        userFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
            args.where.id.in.includes(BEN)
                ? [{ id: BEN, name: "Ben" }]
                : [{ id: ANA, name: "Ana" }]
        );

        const [item] = await listSharedByMe(ANA);
        expect(item.recipient?.name).toBe("Ben");
    });
});
