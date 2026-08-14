/**
 * Vaults: `src/lib/vault/orgs.ts`.
 *
 * The rules worth pinning down here are the ones a slip in would leak or lock
 * out silently - a member confirmed without a well-formed key, a scope that
 * grants a collection of somebody else's vault, a collection touched across the
 * wrong boundary, a create that clobbers an existing vault instead of refusing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ENC = "2.AAAA|BBBB|CCCC";

const vaultOrganizationFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const vaultOrganizationCreate = vi.fn(async (_args: unknown) => ({ id: "vorg-1" }));
const vaultOrganizationCount = vi.fn(async (_args: unknown) => 0);
const vaultOrganizationDeleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultOrganizationUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultOrgUserUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultOrgUserFindUnique = vi.fn(
    async (_args: unknown) => null as { userId: string | null } | null
);
const vaultOrgUserFindFirst = vi.fn(
    async (_args: unknown) => null as { userId: string | null } | null
);
const vaultOrgUserFindMany = vi.fn(
    async (_args: unknown) => [] as { id: string; userId: string | null }[]
);
const vaultOrgUserDelete = vi.fn(async (_args: unknown) => undefined);
const vaultCollectionCreate = vi.fn(
    async (args: { data: { orgId: string; name: string; externalId: string | null } }) => ({
        id: "col-1",
        name: args.data.name,
        externalId: args.data.externalId
    })
);
const vaultCollectionFindMany = vi.fn(async (_args: unknown) => [] as { id: string }[]);
const vaultCollectionFindFirst = vi.fn(async (_args: unknown) => null as { id: string } | null);
const vaultCollectionUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultCollectionDeleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const vaultCollectionAccessDeleteMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const vaultCollectionAccessCreateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const vaultCollectionAccessFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
        vaultOrganization: {
            findUnique: vaultOrganizationFindUnique,
            create: vaultOrganizationCreate,
            count: vaultOrganizationCount,
            deleteMany: vaultOrganizationDeleteMany,
            updateMany: vaultOrganizationUpdateMany
        },
        vaultOrgUser: {
            updateMany: vaultOrgUserUpdateMany,
            findUnique: vaultOrgUserFindUnique,
            findFirst: vaultOrgUserFindFirst,
            delete: vaultOrgUserDelete,
            findMany: vaultOrgUserFindMany
        },
        vaultCollection: {
            create: vaultCollectionCreate,
            updateMany: vaultCollectionUpdateMany,
            deleteMany: vaultCollectionDeleteMany,
            findFirst: vaultCollectionFindFirst,
            findMany: vaultCollectionFindMany
        },
        vaultCollectionAccess: {
            deleteMany: vaultCollectionAccessDeleteMany,
            createMany: vaultCollectionAccessCreateMany,
            findMany: vaultCollectionAccessFindMany
        }
    }
}));

const recordAudit = vi.fn(async () => undefined);
vi.mock("@/lib/audit-service", () => ({ recordAudit }));

const bumpRevision = vi.fn(async () => undefined);
vi.mock("@/lib/vault/account", () => ({ bumpRevision }));

const deleteVaultBlob = vi.fn(async () => undefined);
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob }));

const vaultAttachmentPaths = vi.fn(async () => [] as string[]);
vi.mock("@/lib/vault/ciphers", () => ({ vaultAttachmentPaths }));

const orgs = await import("../../src/lib/vault/orgs");
const core = await import("@polaris/core");

/** Everything reaching this vault, for a scope that should be written whole. */
const WHOLE: import("@polaris/core").VaultScope = { accessAll: true, collections: [] };

beforeEach(() => {
    vi.clearAllMocks();
    vaultOrganizationFindUnique.mockResolvedValue(null);
    vaultOrganizationCreate.mockResolvedValue({ id: "vorg-1" });
    vaultOrganizationCount.mockResolvedValue(0);
    vaultOrganizationDeleteMany.mockResolvedValue({ count: 1 });
    vaultOrganizationUpdateMany.mockResolvedValue({ count: 1 });
    vaultOrgUserUpdateMany.mockResolvedValue({ count: 1 });
    vaultOrgUserFindMany.mockResolvedValue([]);
    vaultCollectionFindMany.mockResolvedValue([]);
    vaultCollectionUpdateMany.mockResolvedValue({ count: 1 });
    vaultCollectionDeleteMany.mockResolvedValue({ count: 1 });
    vaultAttachmentPaths.mockResolvedValue([]);
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
                ownerUserId: null,
                name: null,
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

describe("createPersonalVault", () => {
    const input = {
        name: "Side project",
        creatorUserId: "u1",
        publicKey: "pub-key",
        encryptedPrivateKey: ENC,
        creatorKey: ENC,
        collectionName: ENC,
        creatorEmail: "Owner@Example.com"
    };

    it("refuses keys that are not encrypted values", async () => {
        const result = await orgs.createPersonalVault({ ...input, creatorKey: "not-encrypted" });
        expect(result).toEqual({ ok: false, reason: "keys" });
        expect(vaultOrganizationCreate).not.toHaveBeenCalled();
    });

    it("refuses once the account is at its limit", async () => {
        vaultOrganizationCount.mockResolvedValue(core.MAX_OWNED_VAULTS);
        expect(await orgs.createPersonalVault(input)).toEqual({ ok: false, reason: "too_many" });
        expect(vaultOrganizationCreate).not.toHaveBeenCalled();
    });

    it("writes it owned by the creator, with no organization behind it", async () => {
        expect(await orgs.createPersonalVault(input)).toEqual({ ok: true, id: "vorg-1" });
        expect(vaultOrganizationCreate).toHaveBeenCalledWith({
            data: {
                organizationId: null,
                ownerUserId: "u1",
                name: "Side project",
                publicKey: "pub-key",
                privateKey: ENC,
                members: {
                    create: {
                        userId: "u1",
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
    });
});

describe("renameVault", () => {
    it("only ever touches a vault somebody owns", async () => {
        await orgs.renameVault("vorg-1", "Family");
        expect(vaultOrganizationUpdateMany).toHaveBeenCalledWith({
            where: { id: "vorg-1", ownerUserId: { not: null } },
            data: { name: "Family" }
        });
    });

    it("answers false when nothing was renamed", async () => {
        vaultOrganizationUpdateMany.mockResolvedValue({ count: 0 });
        expect(await orgs.renameVault("vorg-1", "Family")).toBe(false);
    });
});

describe("deleteVault", () => {
    it("drops the attachment ciphertext and bumps everybody who was in it", async () => {
        vaultOrgUserFindMany.mockResolvedValue([
            { id: "m1", userId: "u1" },
            { id: "m2", userId: "u2" }
        ]);
        vaultAttachmentPaths.mockResolvedValue(["vault/a", "vault/b"]);
        expect(await orgs.deleteVault("vorg-1")).toBe(true);
        expect(deleteVaultBlob).toHaveBeenCalledWith("vault/a");
        expect(deleteVaultBlob).toHaveBeenCalledWith("vault/b");
        expect(bumpRevision).toHaveBeenCalledWith("u1");
        expect(bumpRevision).toHaveBeenCalledWith("u2");
    });

    it("leaves the blobs alone when there was no vault to delete", async () => {
        vaultOrganizationDeleteMany.mockResolvedValue({ count: 0 });
        vaultAttachmentPaths.mockResolvedValue(["vault/a"]);
        expect(await orgs.deleteVault("vorg-1")).toBe(false);
        expect(deleteVaultBlob).not.toHaveBeenCalled();
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
        expect(await orgs.confirmMember("vorg-1", "m1", "plaintext", WHOLE)).toBe(false);
        expect(vaultOrgUserUpdateMany).not.toHaveBeenCalled();
    });

    it("refuses a member id that is not in this vault", async () => {
        vaultOrgUserUpdateMany.mockResolvedValue({ count: 0 });
        expect(await orgs.confirmMember("vorg-1", "m1", ENC, WHOLE)).toBe(false);
        expect(bumpRevision).not.toHaveBeenCalled();
    });

    it("hands over the key, marks confirmed, and grants what the scope says", async () => {
        vaultOrgUserFindUnique.mockResolvedValue({ userId: "u2" });
        expect(await orgs.confirmMember("vorg-1", "m1", ENC, WHOLE)).toBe(true);
        expect(vaultOrgUserUpdateMany).toHaveBeenCalledWith({
            where: { id: "m1", orgId: "vorg-1" },
            data: { key: ENC, status: core.ORG_USER_CONFIRMED, accessAll: true }
        });
        expect(bumpRevision).toHaveBeenCalledWith("u2");
    });

    it("confirms into named collections without granting the whole vault", async () => {
        vaultCollectionFindMany.mockResolvedValue([{ id: "col-1" }]);
        expect(
            await orgs.confirmMember("vorg-1", "m1", ENC, {
                accessAll: false,
                collections: [{ collectionId: "col-1", readOnly: true, hidePasswords: false }]
            })
        ).toBe(true);
        expect(vaultOrgUserUpdateMany).toHaveBeenCalledWith({
            where: { id: "m1", orgId: "vorg-1" },
            data: { key: ENC, status: core.ORG_USER_CONFIRMED, accessAll: false }
        });
        expect(vaultCollectionAccessCreateMany).toHaveBeenCalledWith({
            data: [
                {
                    orgUserId: "m1",
                    collectionId: "col-1",
                    readOnly: true,
                    hidePasswords: false
                }
            ]
        });
    });
});

describe("setMemberScope", () => {
    it("replaces the rows rather than merging them", async () => {
        await orgs.setMemberScope("vorg-1", "m1", WHOLE);
        expect(vaultCollectionAccessDeleteMany).toHaveBeenCalledWith({
            where: { orgUserId: "m1" }
        });
        // Nothing to write beside `accessAll`, and no leftover rows to outlive it.
        expect(vaultCollectionAccessCreateMany).not.toHaveBeenCalled();
    });

    it("drops a collection that belongs to another vault", async () => {
        // Only `col-1` comes back scoped to this vault; `col-elsewhere` does not.
        vaultCollectionFindMany.mockResolvedValue([{ id: "col-1" }]);
        await orgs.setMemberScope("vorg-1", "m1", {
            accessAll: false,
            collections: [
                { collectionId: "col-1", readOnly: false, hidePasswords: false },
                { collectionId: "col-elsewhere", readOnly: false, hidePasswords: false }
            ]
        });
        expect(vaultCollectionAccessCreateMany).toHaveBeenCalledWith({
            data: [
                { orgUserId: "m1", collectionId: "col-1", readOnly: false, hidePasswords: false }
            ]
        });
    });

    it("refuses a member id that is not in this vault", async () => {
        vaultOrgUserUpdateMany.mockResolvedValue({ count: 0 });
        expect(await orgs.setMemberScope("vorg-1", "m1", WHOLE)).toBe(false);
        expect(vaultCollectionAccessDeleteMany).not.toHaveBeenCalled();
    });
});

describe("setCollectionMembers", () => {
    it("does nothing when the collection is not in this vault", async () => {
        vaultCollectionFindFirst.mockResolvedValue(null);
        await orgs.setCollectionMembers("vorg-1", "col-elsewhere", [
            { id: "m1", readOnly: false, hidePasswords: false }
        ]);
        expect(vaultCollectionAccessDeleteMany).not.toHaveBeenCalled();
    });

    it("keeps only members of this vault, and bumps them", async () => {
        vaultCollectionFindFirst.mockResolvedValue({ id: "col-1" });
        vaultOrgUserFindMany.mockResolvedValue([{ id: "m1", userId: "u2" }]);
        await orgs.setCollectionMembers("vorg-1", "col-1", [
            { id: "m1", readOnly: true, hidePasswords: true },
            { id: "m-elsewhere", readOnly: false, hidePasswords: false }
        ]);
        expect(vaultCollectionAccessCreateMany).toHaveBeenCalledWith({
            data: [
                { collectionId: "col-1", orgUserId: "m1", readOnly: true, hidePasswords: true }
            ]
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
