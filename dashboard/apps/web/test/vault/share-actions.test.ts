/**
 * Vault sharing server actions: `src/app/(app)/vault/share-actions.ts`.
 *
 * Every one of these is gated on `administered()` (Polaris says this account
 * may manage the organization's vault, and the vault exists), except
 * `shareItemAction`, which is gated on ownership plus standing inside
 * `ciphers.shareCipher`. The rule worth pinning down is that a permission
 * check and a data check are both required - one without the other is a hole.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ENC = "2.AAAA|BBBB|CCCC";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ORG_ID = "vorg-1";

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
const listMyOrgs = vi.fn(async () => [] as { id: string }[]);
vi.mock("@/lib/orgs/org-service", () => ({
    resolveOrgAccess: (...args: unknown[]) => resolveOrgAccess(...args),
    orgCan: (...args: [unknown, string]) => orgCan(...args),
    listMyOrgs: (...args: unknown[]) => listMyOrgs(...args)
}));

const vaultOrgFor = vi.fn(
    async () => null as { id: string; publicKey: string; privateKey: string } | null
);
const createOrganizationVault = vi.fn(
    async () =>
        ({ ok: true, id: VAULT_ORG_ID }) as
            | { ok: true; id: string }
            | { ok: false; reason: "exists" | "keys" }
);
vi.mock("@/lib/vault/orgs", () => ({
    vaultOrgFor: (...args: unknown[]) => vaultOrgFor(...args),
    createOrganizationVault: (...args: unknown[]) => createOrganizationVault(...args),
    vaultOrgsFor: vi.fn(async () => new Map()),
    membershipsFor: vi.fn(async () => new Map()),
    listMembers: vi.fn(async () => []),
    inviteMember: vi.fn(async () => ({ ok: true })),
    confirmMember: vi.fn(async () => true),
    removeMember: vi.fn(async () => true),
    listOrgCollections: vi.fn(async () => []),
    createCollection: vi.fn(async () => ({ id: "col-1" })),
    updateCollection: vi.fn(async () => ({ id: "col-1" })),
    deleteCollection: vi.fn(async () => true),
    setCollectionAccess: vi.fn(async () => undefined),
    standingIn: vi.fn(async () => null)
}));

const shareCipher = vi.fn(async () => ({ ok: true }) as { ok: boolean });
vi.mock("@/lib/vault/ciphers", () => ({
    shareCipher: (...args: unknown[]) => shareCipher(...args)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: { findUnique: vi.fn(async () => null) },
        vaultAccount: { findMany: vi.fn(async () => []) },
        vaultOrgUser: { findFirst: vi.fn(async () => null) },
        vaultCollection: { findFirst: vi.fn(async () => null) },
        vaultCollectionAccess: { findMany: vi.fn(async () => []) }
    }
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const actions = await import("../../src/app/(app)/vault/share-actions");

beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ id: "u1", email: "ana@example.com", isAdmin: false });
    resolveOrgAccess.mockResolvedValue(null);
    orgCan.mockReturnValue(false);
    vaultOrgFor.mockResolvedValue(null);
});

describe("the administered() gate, exercised through saveVaultCollectionAction", () => {
    it("refuses somebody without vault.manage on the organization", async () => {
        orgCan.mockReturnValue(false);
        const result = await actions.saveVaultCollectionAction(ORG_ID, null, ENC);
        expect(result.error).toBe("You cannot administer that organization's vault.");
    });

    it("refuses an administrator when the organization has no vault yet", async () => {
        orgCan.mockReturnValue(true);
        vaultOrgFor.mockResolvedValue(null);
        const result = await actions.saveVaultCollectionAction(ORG_ID, null, ENC);
        expect(result.error).toBe("That organization has no vault yet.");
    });

    it("lets an administrator with an existing vault through to the data check", async () => {
        orgCan.mockReturnValue(true);
        vaultOrgFor.mockResolvedValue({ id: VAULT_ORG_ID, publicKey: "pub", privateKey: ENC });
        const result = await actions.saveVaultCollectionAction(ORG_ID, null, "plaintext");
        // Membership and vault-existence pass; the name is still not encrypted.
        expect(result.error).toBe("A collection name must be encrypted.");
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
        createOrganizationVault.mockResolvedValue({ ok: true, id: VAULT_ORG_ID });
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

describe("shareItemAction", () => {
    const validCipher = { type: 2, name: ENC, secureNote: { type: 0 } };

    it("refuses a payload that does not parse as a cipher", async () => {
        const result = await actions.shareItemAction("item-1", { not: "a cipher" }, ["col-1"]);
        expect(result.error).toBeTruthy();
        expect(shareCipher).not.toHaveBeenCalled();
    });

    it("refuses to share into zero collections", async () => {
        const result = await actions.shareItemAction("item-1", validCipher, []);
        expect(result.error).toBe("Pick a collection to share it into.");
        expect(shareCipher).not.toHaveBeenCalled();
    });

    it("reports failure when the caller does not own the item or is not in the organization", async () => {
        shareCipher.mockResolvedValue({ ok: false });
        const result = await actions.shareItemAction("item-1", validCipher, ["col-1"]);
        expect(result.error).toBe("That item could not be shared into that collection.");
    });

    it("shares the item and revalidates the vault on success", async () => {
        shareCipher.mockResolvedValue({ ok: true });
        const result = await actions.shareItemAction("item-1", validCipher, ["col-1", "col-2"]);
        expect(result).toEqual({});
        expect(shareCipher).toHaveBeenCalledWith(
            "u1",
            "item-1",
            expect.objectContaining({ type: 2 }),
            ["col-1", "col-2"]
        );
        expect(revalidatePath).toHaveBeenCalledWith("/vault");
    });
});
