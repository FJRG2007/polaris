/**
 * Vault server actions: `src/app/(app)/vault/share-actions.ts`.
 *
 * Every one of these is gated on `administered()`, and that gate now answers two
 * different questions depending on who owns the vault: an organization's is the
 * Polaris permission `vault.manage`, a personal one is ownership or having been
 * made an administrator of it. The rules worth pinning down are that a
 * permission check and a data check are both required - one without the other is
 * a hole - and that a vault somebody else owns is refused in exactly the same
 * words as a vault that does not exist.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ENC = "2.AAAA|BBBB|CCCC";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "vorg-1";
const REFUSED = "You cannot administer that vault.";

const requirePermission = vi.fn(
    async () =>
        ({ id: "u1", email: "ana@example.com", isAdmin: false }) as {
            id: string;
            email: string;
            isAdmin: boolean;
        }
);
vi.mock("@/lib/session", () => ({
    requirePermission: (...args: unknown[]) => requirePermission(...args)
}));

const resolveOrgAccess = vi.fn(async () => null as unknown);
const orgCan = vi.fn((_access: unknown, _permission: string) => false);
const listMyOrgs = vi.fn(async () => [] as { id: string; name: string; slug: string }[]);
vi.mock("@/lib/orgs/org-service", () => ({
    resolveOrgAccess: (...args: unknown[]) => resolveOrgAccess(...args),
    orgCan: (...args: [unknown, string]) => orgCan(...args),
    listMyOrgs: (...args: unknown[]) => listMyOrgs(...args)
}));

interface VaultRow {
    id: string;
    organizationId: string | null;
    ownerUserId: string | null;
    name: string | null;
}

const vaultById = vi.fn(async () => null as VaultRow | null);
const vaultsReachableBy = vi.fn(async () => [] as unknown[]);
const createOrganizationVault = vi.fn(
    async () =>
        ({ ok: true, id: VAULT_ID }) as { ok: true; id: string } | { ok: false; reason: string }
);
const createPersonalVault = vi.fn(
    async () =>
        ({ ok: true, id: VAULT_ID }) as { ok: true; id: string } | { ok: false; reason: string }
);
const renameVault = vi.fn(async () => true);
const deleteVault = vi.fn(async () => true);
const confirmMember = vi.fn(async () => true);
const setMemberScope = vi.fn(async () => true);
const inviteMember = vi.fn(async () => ({ ok: true }));
const removeMember = vi.fn(async () => true);
const standingIn = vi.fn(async () => null as unknown);
const mayAdminister = vi.fn(() => false);
vi.mock("@/lib/vault/orgs", () => ({
    vaultById: (...args: unknown[]) => vaultById(...args),
    vaultsReachableBy: (...args: unknown[]) => vaultsReachableBy(...args),
    createOrganizationVault: (...args: unknown[]) => createOrganizationVault(...args),
    createPersonalVault: (...args: unknown[]) => createPersonalVault(...args),
    renameVault: (...args: unknown[]) => renameVault(...args),
    deleteVault: (...args: unknown[]) => deleteVault(...args),
    confirmMember: (...args: unknown[]) => confirmMember(...args),
    setMemberScope: (...args: unknown[]) => setMemberScope(...args),
    inviteMember: (...args: unknown[]) => inviteMember(...args),
    standingIn: (...args: unknown[]) => standingIn(...args),
    mayAdminister: (...args: unknown[]) => mayAdminister(...args),
    listMembers: vi.fn(async () => []),
    removeMember: (...args: unknown[]) => removeMember(...args),
    listOrgCollections: vi.fn(async () => []),
    createCollection: vi.fn(async () => ({ id: "col-1" })),
    updateCollection: vi.fn(async () => ({ id: "col-1" })),
    deleteCollection: vi.fn(async () => true)
}));

const moveCipher = vi.fn(async () => ({ ok: true }) as { ok: boolean });
vi.mock("@/lib/vault/ciphers", () => ({
    moveCipher: (...args: unknown[]) => moveCipher(...args)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: { findUnique: vi.fn(async () => null) },
        vaultAccount: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
        vaultOrgUser: { findFirst: vi.fn(async () => null) },
        vaultCollection: { findFirst: vi.fn(async () => null) },
        vaultCollectionAccess: { findMany: vi.fn(async () => []) }
    }
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const actions = await import("../../src/app/(app)/vault/share-actions");

/** A vault owned by a Polaris organization. */
const orgVault: VaultRow = {
    id: VAULT_ID,
    organizationId: ORG_ID,
    ownerUserId: null,
    name: null
};

/** A vault of the signed-in account's own. */
const ownVault: VaultRow = {
    id: VAULT_ID,
    organizationId: null,
    ownerUserId: "u1",
    name: "Side project"
};

beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ id: "u1", email: "ana@example.com", isAdmin: false });
    resolveOrgAccess.mockResolvedValue(null);
    orgCan.mockReturnValue(false);
    mayAdminister.mockReturnValue(false);
    vaultById.mockResolvedValue(null);
    standingIn.mockResolvedValue(null);
    listMyOrgs.mockResolvedValue([]);
    vaultsReachableBy.mockResolvedValue([]);
});

describe("the administered() gate, exercised through saveVaultCollectionAction", () => {
    it("refuses a vault that does not exist, in the words it refuses somebody else's", async () => {
        const result = await actions.saveVaultCollectionAction(VAULT_ID, null, ENC);
        expect(result.error).toBe(REFUSED);
    });

    it("refuses somebody without vault.manage on the organization", async () => {
        vaultById.mockResolvedValue(orgVault);
        orgCan.mockReturnValue(false);
        const result = await actions.saveVaultCollectionAction(VAULT_ID, null, ENC);
        expect(result.error).toBe(REFUSED);
    });

    it("lets an administrator of the organization through to the data check", async () => {
        vaultById.mockResolvedValue(orgVault);
        orgCan.mockReturnValue(true);
        const result = await actions.saveVaultCollectionAction(VAULT_ID, null, "plaintext");
        // Permission and existence pass; the name is still not encrypted.
        expect(result.error).toBe("A collection name must be encrypted.");
    });

    it("lets the owner of a personal vault through without any Polaris permission", async () => {
        vaultById.mockResolvedValue(ownVault);
        orgCan.mockReturnValue(false);
        const result = await actions.saveVaultCollectionAction(VAULT_ID, null, "plaintext");
        expect(result.error).toBe("A collection name must be encrypted.");
        // Nothing about an organization was consulted: there is no organization.
        expect(resolveOrgAccess).not.toHaveBeenCalled();
    });

    it("refuses somebody else's personal vault unless they administer it", async () => {
        vaultById.mockResolvedValue({ ...ownVault, ownerUserId: "u2" });
        mayAdminister.mockReturnValue(false);
        expect((await actions.saveVaultCollectionAction(VAULT_ID, null, ENC)).error).toBe(REFUSED);

        mayAdminister.mockReturnValue(true);
        expect(
            (await actions.saveVaultCollectionAction(VAULT_ID, null, "plaintext")).error
        ).toBe("A collection name must be encrypted.");
    });
});

describe("vaultListAction", () => {
    it("marks a vault of this account's own as its own and administrable", async () => {
        vaultsReachableBy.mockResolvedValue([
            {
                id: VAULT_ID,
                organizationId: null,
                ownerUserId: "u1",
                name: "Side project",
                publicKey: "pub",
                organization: null,
                members: [{ id: "m1", key: ENC, status: 2, type: 0, accessAll: true }]
            }
        ]);
        const [view] = await actions.vaultListAction();
        expect(view).toMatchObject({
            vaultId: VAULT_ID,
            organizationId: null,
            name: "Side project",
            mine: true,
            mayAdminister: true,
            confirmed: true,
            wrappedKey: ENC
        });
    });

    it("lists an organization with no vault yet, so there is a way to make one", async () => {
        listMyOrgs.mockResolvedValue([{ id: ORG_ID, name: "Acme", slug: "acme" }]);
        orgCan.mockReturnValue(true);
        const views = await actions.vaultListAction();
        expect(views).toEqual([
            expect.objectContaining({
                vaultId: null,
                organizationId: ORG_ID,
                name: "Acme",
                mayAdminister: true,
                confirmed: false
            })
        ]);
    });

    it("does not offer to administer an organization's vault without vault.manage", async () => {
        listMyOrgs.mockResolvedValue([{ id: ORG_ID, name: "Acme", slug: "acme" }]);
        orgCan.mockReturnValue(false);
        vaultsReachableBy.mockResolvedValue([
            {
                id: VAULT_ID,
                organizationId: ORG_ID,
                ownerUserId: null,
                name: null,
                publicKey: "pub",
                organization: { name: "Acme", slug: "acme" },
                members: [{ id: "m1", key: ENC, status: 2, type: 0, accessAll: true }]
            }
        ]);
        const [view] = await actions.vaultListAction();
        // Confirmed owner of the vault's own membership, and still not an
        // administrator: the organization decides that, not the vault.
        expect(view).toMatchObject({ confirmed: true, mayAdminister: false, mine: false });
    });
});

describe("createPersonalVaultAction", () => {
    const validInput = {
        name: "Side project",
        key: ENC,
        keys: { publicKey: "pub-key", encryptedPrivateKey: ENC },
        collectionName: ENC
    };

    it("rejects a payload that fails the schema before writing anything", async () => {
        const result = await actions.createPersonalVaultAction({ name: "" });
        expect(result.error).toBeTruthy();
        expect(createPersonalVault).not.toHaveBeenCalled();
    });

    it("hands back the new vault's id so the screen can land on it", async () => {
        createPersonalVault.mockResolvedValue({ ok: true, id: VAULT_ID });
        expect(await actions.createPersonalVaultAction(validInput)).toEqual({ vaultId: VAULT_ID });
        expect(createPersonalVault).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "Side project",
                creatorUserId: "u1",
                creatorEmail: "ana@example.com"
            })
        );
        expect(revalidatePath).toHaveBeenCalledWith("/vault", "layout");
    });

    it("says which limit was hit rather than failing generically", async () => {
        createPersonalVault.mockResolvedValue({ ok: false, reason: "too_many" });
        const result = await actions.createPersonalVaultAction(validInput);
        expect(result.error).toContain("vaults of your own");
    });
});

describe("createOrganizationVaultAction", () => {
    const validInput = {
        organizationId: ORG_ID,
        key: ENC,
        keys: { publicKey: "pub-key", encryptedPrivateKey: ENC },
        collectionName: ENC
    };

    it("rejects a payload that fails the schema before touching permissions", async () => {
        const result = await actions.createOrganizationVaultAction({
            organizationId: "not-a-uuid"
        });
        expect(result.error).toBeTruthy();
        expect(resolveOrgAccess).not.toHaveBeenCalled();
        expect(createOrganizationVault).not.toHaveBeenCalled();
    });

    it("refuses a well-formed payload from somebody without vault.manage", async () => {
        orgCan.mockReturnValue(false);
        const result = await actions.createOrganizationVaultAction(validInput);
        expect(result.error).toBe("You cannot set up a vault for that organization.");
        expect(createOrganizationVault).not.toHaveBeenCalled();
    });

    it("creates the vault and revalidates the vault layout for an authorized administrator", async () => {
        orgCan.mockReturnValue(true);
        createOrganizationVault.mockResolvedValue({ ok: true, id: VAULT_ID });
        const result = await actions.createOrganizationVaultAction(validInput);
        expect(result).toEqual({});
        expect(createOrganizationVault).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG_ID,
                creatorUserId: "u1",
                creatorEmail: "ana@example.com"
            })
        );
        expect(revalidatePath).toHaveBeenCalledWith("/vault", "layout");
    });

    it("surfaces 'already has a vault' rather than a generic failure", async () => {
        orgCan.mockReturnValue(true);
        createOrganizationVault.mockResolvedValue({ ok: false, reason: "exists" });
        const result = await actions.createOrganizationVaultAction(validInput);
        expect(result.error).toBe("That organization already has a vault.");
    });
});

describe("deleteVaultAction", () => {
    it("refuses an organization's vault: that is the organization's decision", async () => {
        vaultById.mockResolvedValue(orgVault);
        orgCan.mockReturnValue(true);
        const result = await actions.deleteVaultAction(VAULT_ID);
        expect(result.error).toBe("That is not a vault of yours to delete.");
        expect(deleteVault).not.toHaveBeenCalled();
    });

    it("refuses a personal vault somebody else owns", async () => {
        vaultById.mockResolvedValue({ ...ownVault, ownerUserId: "u2" });
        mayAdminister.mockReturnValue(true);
        expect((await actions.deleteVaultAction(VAULT_ID)).error).toBeTruthy();
        expect(deleteVault).not.toHaveBeenCalled();
    });

    it("deletes a vault of this account's own", async () => {
        vaultById.mockResolvedValue(ownVault);
        expect(await actions.deleteVaultAction(VAULT_ID)).toEqual({});
        expect(deleteVault).toHaveBeenCalledWith(VAULT_ID);
    });
});

describe("member scope", () => {
    const scope = {
        accessAll: false,
        collections: [
            {
                collectionId: "33333333-3333-4333-8333-333333333333",
                readOnly: false,
                hidePasswords: false
            }
        ]
    };

    it("refuses a scope that is not one, before handing over any key", async () => {
        vaultById.mockResolvedValue(ownVault);
        const result = await actions.confirmVaultMemberAction(VAULT_ID, "m1", ENC, {
            accessAll: "yes"
        });
        expect(result.error).toBe("Say what they should reach.");
        expect(confirmMember).not.toHaveBeenCalled();
    });

    it("refuses to hand the key over for a scope that reaches nothing", async () => {
        vaultById.mockResolvedValue(ownVault);
        const result = await actions.confirmVaultMemberAction(VAULT_ID, "m1", ENC, {
            accessAll: false,
            collections: []
        });
        expect(result.error).toBe("Pick the whole vault or at least one collection.");
        expect(confirmMember).not.toHaveBeenCalled();
    });

    it("passes the scope through when it is one", async () => {
        vaultById.mockResolvedValue(ownVault);
        expect(await actions.confirmVaultMemberAction(VAULT_ID, "m1", ENC, scope)).toEqual({});
        expect(confirmMember).toHaveBeenCalledWith(VAULT_ID, "m1", ENC, scope);
    });

    it("does let a scope be narrowed to nothing afterwards, which is how access is cut", async () => {
        vaultById.mockResolvedValue(ownVault);
        expect(
            await actions.setMemberScopeAction(VAULT_ID, "m1", {
                accessAll: false,
                collections: []
            })
        ).toEqual({});
        expect(setMemberScope).toHaveBeenCalled();
    });

    it("refuses to change a scope in a vault this account does not administer", async () => {
        vaultById.mockResolvedValue({ ...ownVault, ownerUserId: "u2" });
        const result = await actions.setMemberScopeAction(VAULT_ID, "m1", scope);
        expect(result.error).toBe(REFUSED);
        expect(setMemberScope).not.toHaveBeenCalled();
    });
});

describe("leaveVaultAction", () => {
    it("tells an owner to delete their own vault rather than leave it", async () => {
        vaultById.mockResolvedValue(ownVault);
        const result = await actions.leaveVaultAction(VAULT_ID);
        expect(result.error).toBe("You own this vault. Delete it instead of leaving it.");
        expect(removeMember).not.toHaveBeenCalled();
    });

    it("takes the caller out of a vault somebody let them into", async () => {
        vaultById.mockResolvedValue({ ...ownVault, ownerUserId: "u2" });
        standingIn.mockResolvedValue({
            memberId: "m9",
            type: 2,
            accessAll: true,
            confirmed: true
        });
        expect(await actions.leaveVaultAction(VAULT_ID)).toEqual({});
        expect(removeMember).toHaveBeenCalledWith(VAULT_ID, "m9");
    });
});

describe("inviteVaultMemberAction", () => {
    it("refuses an address that is not one", async () => {
        vaultById.mockResolvedValue(ownVault);
        const result = await actions.inviteVaultMemberAction(VAULT_ID, "not-an-address", 2);
        expect(result.error).toBe("Enter a valid email address.");
        expect(inviteMember).not.toHaveBeenCalled();
    });

    it("falls back to a plain member for a role number nobody offers", async () => {
        vaultById.mockResolvedValue(ownVault);
        await actions.inviteVaultMemberAction(VAULT_ID, "bo@example.com", 99);
        expect(inviteMember).toHaveBeenCalledWith(VAULT_ID, "bo@example.com", 2);
    });
});

describe("moveItemAction", () => {
    const validCipher = { type: 2, name: ENC, secureNote: { type: 0 } };

    it("refuses a payload that does not parse as a cipher", async () => {
        const result = await actions.moveItemAction("item-1", { not: "a cipher" }, ["col-1"]);
        expect(result.error).toBeTruthy();
        expect(moveCipher).not.toHaveBeenCalled();
    });

    it("refuses to move into a vault without naming a collection", async () => {
        const result = await actions.moveItemAction(
            "item-1",
            { ...validCipher, organizationId: "22222222-2222-4222-8222-222222222222" },
            []
        );
        expect(result.error).toBe("Pick a collection to move it into.");
        expect(moveCipher).not.toHaveBeenCalled();
    });

    it("allows a move back to this account's own vault, which has no collections", async () => {
        moveCipher.mockResolvedValue({ ok: true });
        expect(await actions.moveItemAction("item-1", validCipher, [])).toEqual({});
        expect(moveCipher).toHaveBeenCalledWith(
            "u1",
            "item-1",
            expect.objectContaining({ type: 2 }),
            []
        );
        expect(revalidatePath).toHaveBeenCalledWith("/vault");
    });

    it("reports failure when the caller cannot write the item or is not in the vault", async () => {
        moveCipher.mockResolvedValue({ ok: false });
        const result = await actions.moveItemAction("item-1", validCipher, []);
        expect(result.error).toBe("That item could not be moved there.");
    });
});
