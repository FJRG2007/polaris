// @vitest-environment jsdom

/**
 * The vaults screen, on the question it exists to answer: how much of a vault
 * one member reaches.
 *
 * The scope is the only part of sharing that is a decision rather than a key
 * operation, and it is the part a slip in hands somebody more than was meant.
 * What is pinned here is that the dialog opens on what the member reaches TODAY,
 * that narrowing it to named collections sends exactly those, and that nothing
 * is saved with neither the whole vault nor a collection chosen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const VAULT_ID = "vorg-1";

const setMemberScopeAction = vi.fn(async () => ({}) as { error?: string });
const confirmVaultMemberAction = vi.fn(async () => ({}) as { error?: string });
const vaultMembersAction = vi.fn(async () => ({
    members: [
        {
            id: "m1",
            email: "bo@example.com",
            name: "Bo",
            status: 2,
            accessAll: true,
            collections: []
        }
    ],
    candidates: []
}));
const vaultCollectionsAction = vi.fn(async () => ({
    collections: [
        { id: "col-1", name: "Servers" },
        { id: "col-2", name: "Banking" }
    ]
}));

vi.mock("@/app/(app)/vault/share-actions", () => ({
    setMemberScopeAction: (...args: unknown[]) => setMemberScopeAction(...args),
    confirmVaultMemberAction: (...args: unknown[]) => confirmVaultMemberAction(...args),
    vaultMembersAction: (...args: unknown[]) => vaultMembersAction(...args),
    vaultCollectionsAction: (...args: unknown[]) => vaultCollectionsAction(...args),
    memberPublicKeyAction: vi.fn(async () => ({ publicKey: "pub" })),
    inviteVaultMemberAction: vi.fn(async () => ({})),
    removeVaultMemberAction: vi.fn(async () => ({})),
    saveVaultCollectionAction: vi.fn(async () => ({})),
    deleteVaultCollectionAction: vi.fn(async () => ({})),
    createPersonalVaultAction: vi.fn(async () => ({ vaultId: VAULT_ID })),
    createOrganizationVaultAction: vi.fn(async () => ({})),
    renameVaultAction: vi.fn(async () => ({})),
    deleteVaultAction: vi.fn(async () => ({}))
}));

// The names come back encrypted under the vault's key; this test is about the
// scope, not about the cryptography that has its own vectors elsewhere.
vi.mock("@/lib/vault/crypto", () => ({
    decrypt: async (value: string) => value,
    encrypt: async (value: string) => `2.${value}`,
    generateSymmetricKey: () => ({}),
    generateRsaKeyPair: async () => ({ publicKey: "pub", privateKey: new Uint8Array() }),
    encryptRsa: async () => "2.AAAA|BBBB|CCCC",
    encryptBytes: async () => "2.AAAA|BBBB|CCCC",
    symmetricKeyBytes: () => new Uint8Array(64)
}));

const vaultKey = {} as never;
vi.mock("@/app/(app)/vault/vault-session", () => ({
    useVaultSession: () => ({
        state: { publicKey: "pub" },
        vaults: [
            {
                vaultId: VAULT_ID,
                organizationId: null,
                name: "Side project",
                mine: true,
                mayAdminister: true,
                wrappedKey: "2.AAAA|BBBB|CCCC",
                confirmed: true,
                publicKey: "pub",
                memberId: "m0"
            }
        ],
        vaultKeys: new Map([[VAULT_ID, vaultKey]]),
        key: vaultKey,
        privateKey: new Uint8Array(),
        reloadVaults: async () => undefined
    })
}));

const { VaultsView } = await import("@/app/(app)/vault/vaults/vaults-view");

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(cleanup);

/** Open the access dialog for the one member on the list. */
async function openAccessDialog(): Promise<void> {
    render(<VaultsView />);
    const edit = await screen.findByRole("button", {
        name: "Change what bo@example.com reaches"
    });
    fireEvent.click(edit);
    await screen.findByRole("checkbox", { name: "The whole vault" });
}

describe("VaultsView access dialog", () => {
    it("opens on what the member reaches today", async () => {
        await openAccessDialog();
        expect(
            (screen.getByRole("checkbox", { name: "The whole vault" }) as HTMLInputElement)
                .checked
        ).toBe(true);
        // Nothing to pick through while they reach all of it.
        expect(screen.queryByRole("checkbox", { name: "Servers" })).toBeNull();
    });

    it("sends exactly the collections that were picked", async () => {
        await openAccessDialog();
        fireEvent.click(screen.getByRole("checkbox", { name: "The whole vault" }));
        fireEvent.click(await screen.findByRole("checkbox", { name: "Servers" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(setMemberScopeAction).toHaveBeenCalled());
        expect(setMemberScopeAction).toHaveBeenCalledWith(VAULT_ID, "m1", {
            accessAll: false,
            collections: [{ collectionId: "col-1", readOnly: false, hidePasswords: false }]
        });
        // Changing a scope never hands the key over again.
        expect(confirmVaultMemberAction).not.toHaveBeenCalled();
    });

    it("will not save a scope that reaches nothing at all", async () => {
        await openAccessDialog();
        fireEvent.click(screen.getByRole("checkbox", { name: "The whole vault" }));
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
            true
        );
        expect(setMemberScopeAction).not.toHaveBeenCalled();
    });
});
