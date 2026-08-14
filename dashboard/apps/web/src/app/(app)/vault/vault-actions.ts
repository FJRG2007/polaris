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
import { requirePermission } from "@/lib/session";
import { sharingBaseUrl } from "@/lib/domain-service";

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

/** Set a vault up from keys the browser just minted. */
export async function createVaultAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.vaultRegisterSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those keys are not usable." };
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
    const parsed = core.vaultPasswordSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
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

/** Delete the vault and everything in it. Irreversible by design. */
export async function deleteVaultAction(input: unknown): Promise<{ error?: string }> {
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

/** Write an item the browser encrypted. */
export async function saveItemAction(
    itemId: string | null,
    input: unknown
): Promise<{ item?: Record<string, unknown>; error?: string }> {
    const user = await requirePermission("vault.use");
    const parsed = core.cipherSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That item is not encrypted." };
    }
    if (!itemId) {
        const item = await ciphers.createCipher(user.id, parsed.data);
        if (!item) return { error: "You are not a member of that organization." };
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

export async function deleteSendAction(sendId: string): Promise<{ error?: string }> {
    const user = await requirePermission("vault.use");
    if (!(await sends.deleteSend(user.id, sendId))) return { error: "That send is not yours." };
    revalidatePath("/vault/sends");
    return {};
}
