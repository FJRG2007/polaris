/**
 * Writing vault items, on the two axes a client can lie about.
 *
 * The first is the organization: the item's `organizationId` and its collections
 * arrive from the client, and being able to name an organization is not the same
 * as belonging to it. The second is what a delete leaves behind - the attachment
 * rows cascade with the item, the ciphertext on storage does not, and bytes with
 * no row naming them can never be reclaimed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORG_USER_CONFIRMED, ORG_USER_INVITED } from "@polaris/core";

const USER = "018f2b7a-0000-7000-8000-0000000000c1";
const ORG = "018f2b7a-0000-7000-8000-0000000000c2";
const COLLECTION = "018f2b7a-0000-7000-8000-0000000000c3";
const OTHER_COLLECTION = "018f2b7a-0000-7000-8000-0000000000c4";
const CIPHER = "018f2b7a-0000-7000-8000-0000000000c5";
const FOLDER = "018f2b7a-0000-7000-8000-0000000000c6";

const orgUsers = vi.fn(async () => [] as Record<string, unknown>[]);
const collections = vi.fn(async () => [] as { id: string }[]);
const folderFindFirst = vi.fn(async () => null as { id: string } | null);
const cipherCreate = vi.fn();
const cipherFindFirst = vi.fn(async () => ({ id: CIPHER }));
const cipherFindMany = vi.fn(async () => [{ id: CIPHER }]);
const cipherUpdateMany = vi.fn(async () => ({ count: 1 }));
const cipherDeleteMany = vi.fn(async () => ({ count: 1 }));
const attachmentFindMany = vi.fn(async () => [] as { storedPath: string }[]);
const transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(txClient) : arg
);
const deleteBlob = vi.fn(async () => undefined);

const txClient = {
    vaultCollectionCipher: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    vaultCipher: { update: vi.fn(async () => cipherRow()) }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultOrgUser: { findMany: orgUsers },
        vaultCollection: { findMany: collections },
        vaultFolder: {
            findFirst: folderFindFirst,
            deleteMany: vi.fn(async () => ({ count: 0 }))
        },
        vaultAttachment: { findMany: attachmentFindMany },
        vaultFavorite: {
            findMany: vi.fn(async () => []),
            findUnique: vi.fn(async () => null),
            create: vi.fn(async () => undefined),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        },
        vaultCipher: {
            create: cipherCreate,
            findFirst: cipherFindFirst,
            findMany: cipherFindMany,
            updateMany: cipherUpdateMany,
            deleteMany: cipherDeleteMany
        },
        $transaction: transaction
    }
}));
vi.mock("@/lib/vault/account", () => ({ bumpRevision: vi.fn(async () => undefined) }));
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob: deleteBlob }));

const ciphers = await import("../../src/lib/vault/ciphers");

/** A stored row in the shape the response builder reads. */
function cipherRow(overrides: Record<string, unknown> = {}) {
    return {
        id: CIPHER,
        userId: null,
        organizationId: ORG,
        folderId: null,
        type: 1,
        data: JSON.stringify({ name: "2.a|b|c" }),
        reprompt: 0,
        createdAt: new Date(),
        revisionDate: new Date(),
        deletedDate: null,
        collections: [],
        attachments: [],
        ...overrides
    };
}

/** The least an item can be and still parse. */
function input(overrides: Record<string, unknown> = {}) {
    return { type: 1, name: "2.a|b|c", ...overrides } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    orgUsers.mockResolvedValue([]);
    collections.mockResolvedValue([]);
    folderFindFirst.mockResolvedValue(null);
    attachmentFindMany.mockResolvedValue([]);
    cipherCreate.mockResolvedValue(cipherRow());
    cipherFindFirst.mockResolvedValue({ id: CIPHER });
    cipherFindMany.mockResolvedValue([{ id: CIPHER }]);
    txClient.vaultCipher.update.mockResolvedValue(cipherRow());
});

describe("createCipher", () => {
    it("refuses an organization the caller is not a confirmed member of", async () => {
        orgUsers.mockResolvedValue([]);
        const result = await ciphers.createCipher(USER, input({ organizationId: ORG }), [
            COLLECTION
        ]);
        expect(result).toBeNull();
        expect(cipherCreate).not.toHaveBeenCalled();
    });

    it("refuses an organization the caller was only invited to", async () => {
        // `confirmedMemberships` asks for confirmed rows, so an invited member
        // simply is not in the answer - pinned here so a looser query is caught.
        orgUsers.mockImplementation(async (args: { where?: { status?: number } } = {}) =>
            args.where?.status === ORG_USER_CONFIRMED
                ? []
                : [{ id: "member-1", orgId: ORG, accessAll: true, status: ORG_USER_INVITED }]
        );
        expect(await ciphers.createCipher(USER, input({ organizationId: ORG }))).toBeNull();
        expect(cipherCreate).not.toHaveBeenCalled();
    });

    it("keeps only the collections that belong to the organization", async () => {
        orgUsers.mockResolvedValue([{ id: "member-1", orgId: ORG, accessAll: true }]);
        collections.mockResolvedValue([{ id: COLLECTION }]);
        await ciphers.createCipher(USER, input({ organizationId: ORG }), [
            COLLECTION,
            OTHER_COLLECTION
        ]);
        expect(collections.mock.calls[0]?.[0]).toMatchObject({ where: { orgId: ORG } });
        expect(cipherCreate.mock.calls[0]?.[0].data.collections).toEqual({
            create: [{ collectionId: COLLECTION }]
        });
    });

    it("files a personal item under a folder that is not the caller's as no folder", async () => {
        folderFindFirst.mockResolvedValue(null);
        await ciphers.createCipher(USER, input({ folderId: FOLDER }));
        expect(cipherCreate.mock.calls[0]?.[0].data.folderId).toBeNull();
    });

    it("keeps a folder the caller owns", async () => {
        folderFindFirst.mockResolvedValue({ id: FOLDER });
        await ciphers.createCipher(USER, input({ folderId: FOLDER }));
        expect(cipherCreate.mock.calls[0]?.[0].data.folderId).toBe(FOLDER);
    });
});

describe("shareCipher", () => {
    it("refuses to hand an owned item to an organization the caller is not in", async () => {
        orgUsers.mockResolvedValue([]);
        const result = await ciphers.shareCipher(USER, CIPHER, input({ organizationId: ORG }), [
            COLLECTION
        ]);
        expect(result).toEqual({ ok: false, reason: "not_found" });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("refuses when none of the named collections are the organization's", async () => {
        orgUsers.mockResolvedValue([{ id: "member-1", orgId: ORG, accessAll: true }]);
        collections.mockResolvedValue([]);
        const result = await ciphers.shareCipher(USER, CIPHER, input({ organizationId: ORG }), [
            OTHER_COLLECTION
        ]);
        expect(result).toEqual({ ok: false, reason: "not_found" });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("shares into the collections that checked out", async () => {
        orgUsers.mockResolvedValue([{ id: "member-1", orgId: ORG, accessAll: true }]);
        collections.mockResolvedValue([{ id: COLLECTION }]);
        const result = await ciphers.shareCipher(USER, CIPHER, input({ organizationId: ORG }), [
            COLLECTION,
            OTHER_COLLECTION
        ]);
        expect(result.ok).toBe(true);
        expect(txClient.vaultCipher.update.mock.calls[0]?.[0].data.collections).toEqual({
            create: [{ collectionId: COLLECTION }]
        });
    });
});

describe("deleteCiphers", () => {
    it("drops the attachment ciphertext when an item is destroyed", async () => {
        attachmentFindMany.mockResolvedValue([
            { storedPath: "polaris/vault/attachment/a/1" },
            { storedPath: "polaris/vault/attachment/a/2" }
        ]);
        await ciphers.deleteCiphers(USER, [CIPHER], false);
        expect(cipherDeleteMany).toHaveBeenCalled();
        expect(deleteBlob.mock.calls.map((call) => call[0])).toEqual([
            "polaris/vault/attachment/a/1",
            "polaris/vault/attachment/a/2"
        ]);
    });

    it("leaves the bytes alone for a move to the trash", async () => {
        attachmentFindMany.mockResolvedValue([{ storedPath: "polaris/vault/attachment/a/1" }]);
        await ciphers.deleteCiphers(USER, [CIPHER], true);
        expect(cipherUpdateMany).toHaveBeenCalled();
        expect(deleteBlob).not.toHaveBeenCalled();
    });

    it("touches nothing the caller cannot write", async () => {
        cipherFindFirst.mockResolvedValue(null);
        expect(await ciphers.deleteCiphers(USER, [CIPHER], false)).toBe(0);
        expect(cipherDeleteMany).not.toHaveBeenCalled();
        expect(deleteBlob).not.toHaveBeenCalled();
    });
});

describe("purgeCiphers", () => {
    it("takes the attachment ciphertext with it", async () => {
        attachmentFindMany.mockResolvedValue([{ storedPath: "polaris/vault/attachment/a/9" }]);
        await ciphers.purgeCiphers(USER);
        expect(deleteBlob).toHaveBeenCalledWith("polaris/vault/attachment/a/9");
    });
});

describe("moveCiphers", () => {
    it("moves into a folder the caller owns", async () => {
        folderFindFirst.mockResolvedValue({ id: FOLDER });
        await ciphers.moveCiphers(USER, [CIPHER], FOLDER);
        expect(cipherUpdateMany.mock.calls[0]?.[0].data.folderId).toBe(FOLDER);
    });

    it("treats somebody else's folder as no folder", async () => {
        folderFindFirst.mockResolvedValue(null);
        await ciphers.moveCiphers(USER, [CIPHER], FOLDER);
        expect(cipherUpdateMany.mock.calls[0]?.[0].data.folderId).toBeNull();
    });
});
