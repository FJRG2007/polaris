"use server";

/**
 * The vault's own screens talk to the server through these, not through the
 * Bitwarden API beside them.
 *
 * Both exist for good reasons and they are not duplicates. The API is for
 * clients that have no Polaris session and prove themselves with a master
 * password; these screens already have a session, and minting a vault token for
 * a browser that is signed in would be a second credential for the same person.
 *
 * What does NOT change between them is the important part: everything below
 * moves values the browser encrypted, and none of it can read a vault.
 */

import * as core from "@polaris/core";
import * as sends from "@/lib/vault/sends";
import { revalidatePath } from "next/cache";
import * as account from "@/lib/vault/account";
import * as ciphers from "@/lib/vault/ciphers";
import * as folders from "@/lib/vault/folders";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/session";
import { verifyAccountPassword } from "@polaris/auth";
import { sharingBaseUrl } from "@/lib/domain-service";
import * as accessLog from "@/lib/vault/access-log";
import type { ItemUseEntry } from "@/lib/vault/item-uses";

/** What the vault screen needs before it can draw anything. */
export interface VaultState {
    /** False when this account has never set a vault up. */
    exists: boolean;
    kdf: core.KdfSettings;
    /** The user's key, wrapped. Useless without the master password. */
    protectedKey: string | null;
    privateKey: string | null;
    /** The public half, which is what an organization's key is wrapped to. */
    publicKey: string | null;
    email: string;
    /** Minutes a browser may keep this vault open while idle. */
    unlockTimeout: number;
}

/** Whether there is a vault, and what the browser needs to open it. */
export async function vaultStateAction(): Promise<VaultState> {
    const user = await requirePermission("vault.use");
    const row = await account.getVault(user.id);
    if (!row) {
        return {
            exists: false,
            kdf: core.DEFAULT_KDF_SETTINGS,
            protectedKey: null,
            privateKey: null,
            publicKey: null,
            email: user.email,
            unlockTimeout: core.DEFAULT_VAULT_UNLOCK_TIMEOUT
        };
    }
    return {
        exists: true,
        kdf: {
            kdf: row.kdf as core.KdfType,
            kdfIterations: row.kdfIterations,
            kdfMemory: row.kdfMemory,
            kdfParallelism: row.kdfParallelism
        },
        protectedKey: row.protectedKey,
        privateKey: row.privateKey,
        publicKey: row.publicKey,
        email: user.email,
        unlockTimeout: row.unlockTimeout
    };
}

/** Change how long a browser may keep this vault open while it is idle. */
export async function setUnlockTimeoutAction(minutes: number): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    if (!(await account.setUnlockTimeout(user.id, minutes))) {
        return { error: "That is not one of the choices." };
    }
    revalidatePath("/vault", "layout");
    return {};
}

/** Set this account's own vault up from keys the browser just minted. */
/**
 * The account password, checked, before a vault is created or rewrapped.
 *
 * Two reasons and they are separate. It proves this is the account holder rather
 * than somebody sitting at an open session, which is the least that should be
 * asked before the root secret of a vault is set. And the screen that collected
 * it has already compared it with the master password in the browser - the only
 * place that comparison can happen, since the master password never arrives
 * here - so this is what makes that comparison something more than a suggestion
 * the client could skip.
 */
async function accountPasswordOk(userId: string, password: string): Promise<boolean> {
    return verifyAccountPassword(auth, userId, password);
}

export async function createAccountVaultAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.vaultSetupSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those keys are not usable." };
    }
    if (!(await accountPasswordOk(user.id, parsed.data.accountPassword))) {
        return { error: "That is not your Polaris password." };
    }
    const result = await account.createVault(user.id, {
        masterPasswordHash: parsed.data.masterPasswordHash,
        masterPasswordHint: parsed.data.masterPasswordHint,
        protectedKey: parsed.data.key,
        publicKey: parsed.data.keys.publicKey,
        encryptedPrivateKey: parsed.data.keys.encryptedPrivateKey,
        kdf: {
            kdf: parsed.data.kdf as core.KdfType,
            kdfIterations: parsed.data.kdfIterations,
            kdfMemory: parsed.data.kdfMemory ?? null,
            kdfParallelism: parsed.data.kdfParallelism ?? null
        }
    });
    if (!result.ok) {
        return {
            error:
                result.reason === "exists"
                    ? "This account already has a vault."
                    : result.reason === "kdf"
                      ? "Those settings are out of range."
                      : "Those keys are not encrypted values."
        };
    }
    revalidatePath("/vault");
    return {};
}

/** Change the master password, with the vault key re-wrapped by the browser. */
export async function changeMasterPasswordAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.vaultPasswordChangeSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
    }
    if (!(await accountPasswordOk(user.id, parsed.data.accountPassword))) {
        return { error: "That is not your Polaris password." };
    }
    const current = await account.getVault(user.id);
    if (!current) return { error: "This account has no vault." };

    const result = await account.changeMasterPassword(user.id, {
        currentHash: parsed.data.masterPasswordHash,
        newHash: parsed.data.newMasterPasswordHash,
        newProtectedKey: parsed.data.key,
        masterPasswordHint: parsed.data.masterPasswordHint ?? undefined,
        kdf:
            parsed.data.kdf === undefined || parsed.data.kdfIterations === undefined
                ? undefined
                : {
                      kdf: parsed.data.kdf as core.KdfType,
                      kdfIterations: parsed.data.kdfIterations,
                      kdfMemory: parsed.data.kdfMemory ?? null,
                      kdfParallelism: parsed.data.kdfParallelism ?? null
                  }
    });
    if (!result.ok) {
        return {
            error:
                result.reason === "wrong_password"
                    ? "That is not your current master password."
                    : result.reason === "kdf"
                      ? "Those settings are out of range."
                      : "Invalid request"
        };
    }
    revalidatePath("/vault");
    return {};
}

/** End every vault session on every device, keeping the password. */
export async function deauthorizeVaultAction(): Promise<void> {
    const user = await requirePermission("vault.use");
    await account.deauthorizeSessions(user.id);
}

/**
 * Delete this account's whole vault - its own items, its keys, and with them
 * every vault of its own. Irreversible by design.
 */
export async function deleteAccountVaultAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.vaultVerifySchema.safeParse(input);
    if (!parsed.success) return { error: "Invalid request" };
    if (!(await account.verifyMasterPassword(user.id, parsed.data.masterPasswordHash))) {
        return { error: "That is not your master password." };
    }
    await account.deleteVault(user.id);
    revalidatePath("/vault");
    return {};
}

/** Everything in the vault, still encrypted. The browser opens it. */
export async function vaultContentsAction(): Promise<{
    ciphers: Record<string, unknown>[];
    folders: Record<string, unknown>[];
    sends: Record<string, unknown>[];
}> {
    const user = await requirePermission("vault.use");
    const [items, folderRows, sendRows] = await Promise.all([
        ciphers.listCiphers(user.id),
        folders.listFolders(user.id),
        sends.listSends(user.id)
    ]);
    return { ciphers: items, folders: folderRows, sends: sendRows };
}

/**
 * Write an item the browser encrypted.
 *
 * A new item can go straight into a vault rather than being made personal and
 * moved: the collections say where inside it lands, and an item written into a
 * vault with none would be one only an administrator ever sees again.
 */
export async function saveItemAction(
    itemId: string | null,
    input: unknown,
    collectionIds: string[] = []
): Promise<{ item?: Record<string, unknown>; error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.cipherSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That item is not encrypted." };
    }
    if (!itemId) {
        if (parsed.data.organizationId && collectionIds.length === 0) {
            return { error: "Pick a collection to put it in." };
        }
        const item = await ciphers.createCipher(user.id, parsed.data, collectionIds);
        if (!item) return { error: "You are not in that vault." };
        revalidatePath("/vault");
        return { item };
    }
    const result = await ciphers.updateCipher(user.id, itemId, parsed.data);
    if (!result.ok) {
        return {
            error:
                result.reason === "conflict"
                    ? "Somebody else changed this item. Reload and try again."
                    : "That item is not yours."
        };
    }
    revalidatePath("/vault");
    return { item: result.cipher };
}

/** Star an item, or take the star off. */
export async function setItemFavoriteAction(itemId: string, favorite: boolean): Promise<void> {
    const user = await requirePermission("vault.use");
    await ciphers.setFavorite(user.id, itemId, favorite);
    revalidatePath("/vault");
}

/** Send an item to the trash, or take it out for good. */
export async function deleteItemAction(itemId: string, soft: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const count = await ciphers.deleteCiphers(user.id, [itemId], soft);
    if (count === 0) return { error: "That item is not yours." };
    revalidatePath("/vault");
    return {};
}

/** Take an item back out of the trash. */
export async function restoreItemAction(itemId: string): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    if ((await ciphers.restoreCiphers(user.id, [itemId])) === 0) {
        return { error: "That item is not yours." };
    }
    revalidatePath("/vault");
    return {};
}

/** Folders, whose names the browser encrypts like everything else. */
export async function saveFolderAction(
    folderId: string | null,
    name: string
): Promise<{ folder?: Record<string, unknown>; error?: string }> {
    const user = await requirePermission("vault.use");
    if (!core.isEncString(name)) return { error: "A folder name must be encrypted." };
    if (!folderId) {
        revalidatePath("/vault");
        return { folder: await folders.createFolder(user.id, name) };
    }
    const folder = await folders.updateFolder(user.id, folderId, name);
    if (!folder) return { error: "That folder is not yours." };
    revalidatePath("/vault");
    return { folder };
}

export async function deleteFolderAction(folderId: string): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    if (!(await folders.deleteFolder(user.id, folderId)))
        return { error: "That folder is not yours." };
    revalidatePath("/vault");
    return {};
}

/**
 * What a browser needs to work out whether a candidate password opens this
 * account's vault: the salt the derivation uses, and how it is stretched.
 *
 * Neither is a secret. The same two are handed to anybody who asks for them by
 * email at prelogin, because a client cannot derive a key without them. What is
 * NOT here is the wrapped key, so nothing about this answer helps somebody who
 * does not already know the password.
 */
export async function vaultDerivationAction(): Promise<{
    exists: boolean;
    email: string;
    kdf: core.KdfSettings;
} | null> {
    const user = await requirePermission("vault.use");
    const vault = await account.getVault(user.id);
    if (!vault) return { exists: false, email: user.email, kdf: core.DEFAULT_KDF_SETTINGS };
    return {
        exists: true,
        email: user.email,
        kdf: {
            kdf: vault.kdf as core.KdfType,
            kdfIterations: vault.kdfIterations,
            kdfMemory: vault.kdfMemory,
            kdfParallelism: vault.kdfParallelism
        }
    };
}

/**
 * Whether a password somebody is about to set on their POLARIS account would
 * also open their vault.
 *
 * The mirror of the check the vault screens make, and it has to be here because
 * it is the only side that can be checked: the server holds a hash of the
 * master password hash and cannot derive anything from a plaintext, so the
 * browser derives the candidate and asks about the result. Nothing is written
 * and nothing else is said - the answer is a boolean about this account's own
 * vault, to this account.
 */
export async function passwordOpensVaultAction(clientHash: string): Promise<{ opens: boolean }> {
    const user = await requirePermission("vault.use");
    return { opens: await account.verifyMasterPassword(user.id, clientHash) };
}

/** Create a Send and hand back the link to give somebody. */
export async function createSendAction(
    input: unknown
): Promise<{ send?: Record<string, unknown>; url?: string; error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.sendSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That send is not encrypted." };
    }
    const send = await sends.createSend(user.id, parsed.data);
    revalidatePath("/vault/sends");
    // A public path rather than the `<origin>/vault/#/send/...` an official
    // client mints: that one is inside the dashboard, which asks a stranger to
    // sign in before the page can even read the fragment. The key goes after
    // this, in the fragment, and the crypto is the same either way.
    return { send, url: `${await sharingBaseUrl()}/vs/${String(send.accessId)}` };
}

/**
 * Record that somebody used one item, and read back what has been done with it.
 *
 * Reported by the browser, because the browser is the only place a vault is ever
 * open - see `vault/access-log`, where the shape and the limits of that
 * guarantee are written down. The use is validated against a fixed list here
 * rather than taken as given, so the log cannot be filled with invented words,
 * and the item is checked against what this account can actually reach.
 */
export async function recordItemUseAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.itemUseSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not something an item can be used for." };
    await accessLog.recordItemUse(user.id, parsed.data.itemId, parsed.data.use);
    return {};
}

export async function itemUsesAction(itemId: string): Promise<ItemUseEntry[]> {
    const user = await requirePermission("vault.use");
    return accessLog.listItemUses(user.id, itemId);
}

export async function deleteSendAction(sendId: string): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    if (!(await sends.deleteSend(user.id, sendId))) return { error: "That send is not yours." };
    revalidatePath("/vault/sends");
    return {};
}
