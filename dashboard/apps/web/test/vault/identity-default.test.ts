/**
 * The identity somebody fills sign-up forms with: one per vault, per person,
 * and only ever an identity that is still in the vault it was picked for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CIPHER_IDENTITY, CIPHER_LOGIN } from "@polaris/core";

const USER = "018f2b7a-0000-7000-8000-0000000000d1";
const ORG = "018f2b7a-0000-7000-8000-0000000000d2";
const IDENTITY = "018f2b7a-0000-7000-8000-0000000000d3";
const OTHER = "018f2b7a-0000-7000-8000-0000000000d4";

const cipherFindFirst = vi.fn(
    async () => null as { id: string; organizationId: string | null } | null
);
const defaultFindMany = vi.fn(async () => [] as Record<string, unknown>[]);
const defaultDeleteMany = vi.fn((args: unknown) => ({ op: "deleteMany", args }));
const defaultCreate = vi.fn((args: unknown) => ({ op: "create", args }));
const transaction = vi.fn(async (ops: unknown) => ops);
const bumpRevision = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultOrgUser: { findMany: vi.fn(async () => []) },
        vaultCipher: { findFirst: cipherFindFirst },
        vaultIdentityDefault: {
            findMany: defaultFindMany,
            deleteMany: defaultDeleteMany,
            create: defaultCreate
        },
        $transaction: transaction
    }
}));
vi.mock("@/lib/vault/account", () => ({ bumpRevision, bumpRevisionFor: vi.fn() }));
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob: vi.fn() }));

const ciphers = await import("../../src/lib/vault/ciphers");
const { identityFromAccount } = await import("../../src/lib/vault/account-identity");

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: IDENTITY,
        userId: USER,
        organizationId: null,
        folderId: null,
        type: CIPHER_IDENTITY,
        data: JSON.stringify({ name: "2.x|y|z" }),
        reprompt: 0,
        createdAt: new Date(0),
        revisionDate: new Date(0),
        deletedDate: null,
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("setDefaultIdentity", () => {
    it("refuses an item this account cannot see, or one that is not an identity", async () => {
        cipherFindFirst.mockResolvedValueOnce(null);
        expect(await ciphers.setDefaultIdentity(USER, IDENTITY, true)).toBe(false);
        const where = JSON.stringify(cipherFindFirst.mock.calls[0]);
        expect(where).toContain(`"type":${CIPHER_IDENTITY}`);
        expect(where).toContain('"deletedDate":null');
        expect(transaction).not.toHaveBeenCalled();
    });

    it("replaces the default of the vault the item is in, never one the caller names", async () => {
        cipherFindFirst.mockResolvedValueOnce({ id: IDENTITY, organizationId: ORG });
        expect(await ciphers.setDefaultIdentity(USER, IDENTITY, true)).toBe(true);
        expect(defaultDeleteMany).toHaveBeenCalledWith({
            where: { userId: USER, vaultOrganizationId: ORG }
        });
        expect(defaultCreate).toHaveBeenCalledWith({
            data: { userId: USER, vaultOrganizationId: ORG, cipherId: IDENTITY }
        });
        expect(bumpRevision).toHaveBeenCalledWith(USER);
    });

    it("keeps the personal vault as its own context", async () => {
        cipherFindFirst.mockResolvedValueOnce({ id: IDENTITY, organizationId: null });
        await ciphers.setDefaultIdentity(USER, IDENTITY, true);
        expect(defaultDeleteMany).toHaveBeenCalledWith({
            where: { userId: USER, vaultOrganizationId: null }
        });
    });

    it("takes the mark off only that item", async () => {
        cipherFindFirst.mockResolvedValueOnce({ id: IDENTITY, organizationId: null });
        await ciphers.setDefaultIdentity(USER, IDENTITY, false);
        expect(defaultDeleteMany).toHaveBeenCalledWith({
            where: { userId: USER, cipherId: IDENTITY }
        });
        expect(defaultCreate).not.toHaveBeenCalled();
    });

    it("settles a race on the unique index without failing", async () => {
        cipherFindFirst.mockResolvedValueOnce({ id: IDENTITY, organizationId: null });
        transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
        expect(await ciphers.setDefaultIdentity(USER, IDENTITY, true)).toBe(true);
    });
});

describe("defaultIdentityIds", () => {
    it("counts a row only while its item is an identity, out of the trash, in that vault", async () => {
        defaultFindMany.mockResolvedValueOnce([
            {
                vaultOrganizationId: null,
                cipher: {
                    id: IDENTITY,
                    type: CIPHER_IDENTITY,
                    organizationId: null,
                    deletedDate: null
                }
            },
            // Moved into an organization after it was picked as the personal one.
            {
                vaultOrganizationId: ORG,
                cipher: {
                    id: OTHER,
                    type: CIPHER_IDENTITY,
                    organizationId: null,
                    deletedDate: null
                }
            },
            {
                vaultOrganizationId: ORG,
                cipher: {
                    id: "trashed",
                    type: CIPHER_IDENTITY,
                    organizationId: ORG,
                    deletedDate: new Date()
                }
            },
            {
                vaultOrganizationId: ORG,
                cipher: { id: "login", type: CIPHER_LOGIN, organizationId: ORG, deletedDate: null }
            }
        ]);
        expect([...(await ciphers.defaultIdentityIds(USER))]).toEqual([IDENTITY]);
    });
});

describe("toCipherResponse", () => {
    it("marks an identity and never anything else", () => {
        expect(ciphers.toCipherResponse(row(), false, true).defaultIdentity).toBe(true);
        expect(ciphers.toCipherResponse(row(), false).defaultIdentity).toBe(false);
        expect(
            ciphers.toCipherResponse(row({ type: CIPHER_LOGIN }), false, true).defaultIdentity
        ).toBe(false);
    });
});

describe("identityFromAccount", () => {
    const base = {
        name: "Ada Lovelace",
        firstName: null,
        lastName: null,
        email: "ada@example.com",
        username: "ada",
        company: null,
        phone: null,
        emails: [] as string[]
    };

    it("uses the two halves of the name when the account has them", () => {
        const out = identityFromAccount({ ...base, firstName: "Augusta Ada", lastName: "King" });
        expect(out).toMatchObject({ firstName: "Augusta Ada", lastName: "King" });
    });

    it("splits a display name at its first space otherwise", () => {
        const out = identityFromAccount({ ...base, name: "  Ada  Byron Lovelace " });
        expect(out).toMatchObject({ firstName: "Ada", lastName: "Byron Lovelace" });
    });

    it("lists the sign-in address first and each address once", () => {
        const out = identityFromAccount({
            ...base,
            emails: ["work@example.com", "ADA@example.com", " ", "work@example.com"]
        });
        expect(out.emails).toEqual(["ada@example.com", "work@example.com"]);
    });

    it("answers empty strings where the account has nothing", () => {
        const out = identityFromAccount({ ...base, username: null });
        expect(out).toMatchObject({ company: "", phone: "", username: "" });
    });
});
