/**
 * Organization vaults: `src/lib/vault/orgs.ts`.
 *
 * The rules worth pinning down here are the ones a slip in would leak or lock
 * out silently - a member confirmed without a well-formed key, a collection
 * touched across the wrong organization's boundary, a create that clobbers an
 * existing vault instead of refusing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ENC = "2.AAAA|BBBB|CCCC";

const vaultOrganizationFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const vaultOrganizationCreate = vi.fn(async (_args: unknown) => ({ id: "vorg-1" }));
const vaultOrgUserUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultOrgUserFindUnique = vi.fn(
    async (_args: unknown) => null as { userId: string | null } | null
);
const vaultOrgUserFindFirst = vi.fn(
    async (_args: unknown) => null as { userId: string | null } | null
);
const vaultOrgUserDelete = vi.fn(async (_args: unknown) => undefined);
const vaultCollectionCreate = vi.fn(
    async (args: { data: { orgId: string; name: string; externalId: string | null } }) => ({
        id: "col-1",
        name: args.data.name,
        externalId: args.data.externalId
    })
);
const vaultCollectionUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultCollectionDeleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultCollectionAccessUpsert = vi.fn(async (_args: unknown) => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultOrganization: {
            findUnique: vaultOrganizationFindUnique,
            create: vaultOrganizationCreate
        },
        vaultOrgUser: {
            updateMany: vaultOrgUserUpdateMany,
            findUnique: vaultOrgUserFindUnique,
            findFirst: vaultOrgUserFindFirst,
            delete: vaultOrgUserDelete,
            findMany: vi.fn(async () => [])
        },
        vaultCollection: {
            create: vaultCollectionCreate,
            updateMany: vaultCollectionUpdateMany,
            deleteMany: vaultCollectionDeleteMany,
            findMany: vi.fn(async () => [])
        },
        vaultCollectionAccess: { upsert: vaultCollectionAccessUpsert }
    }
}));

const recordAudit = vi.fn(async () => undefined);
vi.mock("@/lib/audit-service", () => ({ recordAudit }));

const bumpRevision = vi.fn(async () => undefined);
vi.mock("@/lib/vault/account", () => ({ bumpRevision }));

const orgs = await import("../../src/lib/vault/orgs");
const core = await import("@polaris/core");

beforeEach(() => {
    vi.clearAllMocks();
    vaultOrganizationFindUnique.mockResolvedValue(null);
    vaultOrganizationCreate.mockResolvedValue({ id: "vorg-1" });
    vaultOrgUserUpdateMany.mockResolvedValue({ count: 1 });
    vaultCollectionUpdateMany.mockResolvedValue({ count: 1 });
    vaultCollectionDeleteMany.mockResolvedValue({ count: 1 });
});

describe("createOrganizationVault", () => {
    const input = {
        organizationId: "org-1",
        creatorUserId: "u1",
        publicKey: "pub-key",
        encryptedPrivateKey: ENC,
        creatorKey: ENC,
        collectionName: ENC,
        creatorEmail: "Owner@Example.com"
    };

    it("refuses keys that are not encrypted values", async () => {
        const result = await orgs.createOrganizationVault({
            ...input,
            creatorKey: "not-encrypted"
        });
        expect(result).toEqual({ ok: false, reason: "keys" });
        expect(vaultOrganizationCreate).not.toHaveBeenCalled();
    });

    it("refuses to create a second vault for the same organization", async () => {
        vaultOrganizationFindUnique.mockResolvedValue({ id: "vorg-existing" });
        const result = await orgs.createOrganizationVault(input);
        expect(result).toEqual({ ok: false, reason: "exists" });
        expect(vaultOrganizationCreate).not.toHaveBeenCalled();
    });

    it("creates the vault, its owner membership, and the first collection in one write", async () => {
        const result = await orgs.createOrganizationVault(input);
        expect(result).toEqual({ ok: true, id: "vorg-1" });
        expect(vaultOrganizationCreate).toHaveBeenCalledWith({
            data: {
                organizationId: "org-1",
                publicKey: "pub-key",
                privateKey: ENC,
                members: {
                    create: {
                        userId: "u1",
                        // Stored lowercase so a differently-cased invite still matches.
                        email: "owner@example.com",
                        status: core.ORG_USER_CONFIRMED,
                        type: core.ORG_ROLE_OWNER,
                        key: ENC,
                        accessAll: true
                    }
                },
                collections: { create: { name: ENC } }
            },
            select: { id: true }
        });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "u1",
                action: "vault.org.create",
                targetId: "org-1"
            })
        );
        expect(bumpRevision).toHaveBeenCalledWith("u1");
    });
});

describe("mayAdminister", () => {
    it("is false for an unconfirmed member regardless of role", () => {
        expect(
            orgs.mayAdminister({
                memberId: "m1",
                type: core.ORG_ROLE_OWNER,
                accessAll: true,
                confirmed: false
            })
        ).toBe(false);
    });

    it("is false for a confirmed plain member", () => {
        expect(
            orgs.mayAdminister({
                memberId: "m1",
                type: core.ORG_ROLE_USER,
                accessAll: true,
                confirmed: true
            })
        ).toBe(false);
    });

    it("is true for a confirmed owner, admin, or manager", () => {
        for (const type of [core.ORG_ROLE_OWNER, core.ORG_ROLE_ADMIN, core.ORG_ROLE_MANAGER]) {
            expect(
                orgs.mayAdminister({ memberId: "m1", type, accessAll: true, confirmed: true })
            ).toBe(true);
        }
    });

    it("is false for no membership at all", () => {
        expect(orgs.mayAdminister(null)).toBe(false);
    });
});

describe("confirmMember", () => {
    it("refuses a wrapped key that is not an encrypted value", async () => {
        expect(await orgs.confirmMember("vorg-1", "m1", "plaintext")).toBe(false);
        expect(vaultOrgUserUpdateMany).not.toHaveBeenCalled();
    });

    it("refuses a member id that is not in this vault", async () => {
        vaultOrgUserUpdateMany.mockResolvedValue({ count: 0 });
        expect(await orgs.confirmMember("vorg-1", "m1", ENC)).toBe(false);
        expect(bumpRevision).not.toHaveBeenCalled();
    });

    it("hands over the key, marks confirmed, and grants the whole organization", async () => {
        vaultOrgUserFindUnique.mockResolvedValue({ userId: "u2" });
        expect(await orgs.confirmMember("vorg-1", "m1", ENC)).toBe(true);
        expect(vaultOrgUserUpdateMany).toHaveBeenCalledWith({
            where: { id: "m1", orgId: "vorg-1" },
            data: { key: ENC, status: core.ORG_USER_CONFIRMED, accessAll: true }
        });
        expect(bumpRevision).toHaveBeenCalledWith("u2");
    });
});

describe("removeMember", () => {
    it("refuses a member that is not in this organization's vault", async () => {
        vaultOrgUserFindFirst.mockResolvedValue(null);
        expect(await orgs.removeMember("vorg-1", "m1")).toBe(false);
        expect(vaultOrgUserDelete).not.toHaveBeenCalled();
    });

    it("deletes the membership and bumps the removed member's revision", async () => {
        vaultOrgUserFindFirst.mockResolvedValue({ userId: "u2" });
        expect(await orgs.removeMember("vorg-1", "m1")).toBe(true);
        expect(vaultOrgUserDelete).toHaveBeenCalledWith({ where: { id: "m1" } });
        expect(bumpRevision).toHaveBeenCalledWith("u2");
    });
});

describe("collections", () => {
    it("refuses a collection name that is not encrypted, on create and on rename", async () => {
        expect(await orgs.createCollection("vorg-1", "plaintext")).toBeNull();
        expect(vaultCollectionCreate).not.toHaveBeenCalled();

        expect(await orgs.updateCollection("vorg-1", "col-1", "plaintext")).toBeNull();
        expect(vaultCollectionUpdateMany).not.toHaveBeenCalled();
    });

    it("creates a collection scoped to the organization", async () => {
        const collection = await orgs.createCollection("vorg-1", ENC);
        expect(collection).toEqual({
            object: "collection",
            id: "col-1",
            organizationId: "vorg-1",
            name: ENC,
            externalId: null
        });
        expect(vaultCollectionCreate).toHaveBeenCalledWith({
            data: { orgId: "vorg-1", name: ENC, externalId: null },
            select: { id: true, name: true, externalId: true }
        });
    });

    it("refuses to rename a collection that belongs to a different organization", async () => {
        vaultCollectionUpdateMany.mockResolvedValue({ count: 0 });
        const result = await orgs.updateCollection("vorg-1", "col-in-another-org", ENC);
        expect(result).toBeNull();
    });

    it("refuses to delete a collection that is not in this vault", async () => {
        vaultCollectionDeleteMany.mockResolvedValue({ count: 0 });
        expect(await orgs.deleteCollection("vorg-1", "col-x")).toBe(false);
    });

    it("deletes a collection that is scoped to this organization", async () => {
        expect(await orgs.deleteCollection("vorg-1", "col-1")).toBe(true);
        expect(vaultCollectionDeleteMany).toHaveBeenCalledWith({
            where: { id: "col-1", orgId: "vorg-1" }
        });
    });
});

describe("setCollectionAccess", () => {
    it("upserts the access row and bumps the granted member's revision", async () => {
        vaultOrgUserFindUnique.mockResolvedValue({ userId: "u2" });
        await orgs.setCollectionAccess("col-1", "m1", { readOnly: true, hidePasswords: false });
        expect(vaultCollectionAccessUpsert).toHaveBeenCalledWith({
            where: { collectionId_orgUserId: { collectionId: "col-1", orgUserId: "m1" } },
            create: {
                collectionId: "col-1",
                orgUserId: "m1",
                readOnly: true,
                hidePasswords: false
            },
            update: { readOnly: true, hidePasswords: false }
        });
        expect(bumpRevision).toHaveBeenCalledWith("u2");
    });
});
