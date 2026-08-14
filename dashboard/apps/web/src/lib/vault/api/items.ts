/**
 * Items and folders over the API.
 *
 * Thin on purpose: the decisions - who reaches what, what a write may change,
 * how the trash behaves - live in the services, and these handlers only turn a
 * request into a call and a result into the response shape clients read.
 *
 * The endpoints come in pairs because clients differ: the same operation is a
 * PUT for one and a POST for another, and both are wired to the same handler
 * rather than one of them being "the real one".
 */

import * as core from "@polaris/core";
import { vaultError } from "@/lib/vault/auth";
import * as ciphers from "@/lib/vault/ciphers";
import * as folders from "@/lib/vault/folders";
import { verifyMasterPassword } from "@/lib/vault/account";
import { readJsonBody, requirePrincipal, type VaultContext } from "@/lib/vault/api/router";

/** A list in the envelope clients unwrap. */
function list(data: unknown[]): Response {
    return Response.json({ object: "list", continuationToken: null, data });
}

export async function listCiphers(context: VaultContext): Promise<Response> {
    return list(await ciphers.listCiphers(requirePrincipal(context).userId));
}

export async function getCipher(context: VaultContext): Promise<Response> {
    const cipher = await ciphers.getCipher(
        requirePrincipal(context).userId,
        context.params.id ?? ""
    );
    if (!cipher) return vaultError("Not found", 404);
    return Response.json(cipher);
}

export async function createCipher(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid item", 400);
    }
    const cipher = await ciphers.createCipher(principal.userId, parsed.data);
    if (!cipher) return vaultError("Not found", 404);
    return Response.json(cipher);
}

/** Creating an item straight into an organization's collections. */
export async function createCipherInCollections(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherCreateSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid item", 400);
    }
    const cipher = await ciphers.createCipher(
        principal.userId,
        parsed.data.cipher,
        parsed.data.collectionIds
    );
    if (!cipher) return vaultError("Not found", 404);
    return Response.json(cipher);
}

export async function updateCipher(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid item", 400);
    }
    const result = await ciphers.updateCipher(
        principal.userId,
        context.params.id ?? "",
        parsed.data
    );
    if (!result.ok) {
        if (result.reason === "conflict") {
            // 409, not a silent overwrite: two people editing one shared login
            // should be told, and the client offers to reload.
            return vaultError("Somebody else changed this item. Refresh and try again.", 409);
        }
        return vaultError("Not found", 404);
    }
    return Response.json(result.cipher);
}

/**
 * Filing and starring, without the item.
 *
 * A browser extension moving a login into a folder sends this rather than the
 * whole login, which is the difference between one small write and re-uploading
 * every field it is holding open.
 */
export async function updateCipherPartial(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherPartialSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("Invalid request", 400);
    const result = await ciphers.updateCipherPartial(
        principal.userId,
        context.params.id ?? "",
        parsed.data
    );
    if (!result.ok) return vaultError("Not found", 404);
    return Response.json(result.cipher);
}

/** Which of an organization's collections an item sits in. */
export async function setCipherCollections(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherCollectionsSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("Invalid request", 400);
    const result = await ciphers.setCipherCollections(
        principal.userId,
        context.params.id ?? "",
        parsed.data.collectionIds
    );
    if (!result.ok) return vaultError("Not found", 404);
    // The v2 spelling wants the item wrapped; the older one wants it bare. Both
    // are answered with the wrapper, which newer clients read and older ones
    // ignore the extra key of.
    return Response.json({ ...result.cipher, cipher: result.cipher });
}

/** Every item of one organization, which is what a client's org view lists. */
export async function listOrganizationCiphers(context: VaultContext): Promise<Response> {
    const organizationId = context.query.get("organizationId") ?? "";
    if (!organizationId) return list([]);
    return list(
        await ciphers.listOrganizationCiphers(requirePrincipal(context).userId, organizationId)
    );
}

/**
 * A vault imported from a client's own screen.
 *
 * One request for the whole file, because the folders and the items are paired
 * by position and that pairing only exists while both are in hand.
 */
export async function importCiphers(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.vaultImportSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
    }
    await ciphers.importCiphers(principal.userId, parsed.data);
    return new Response(null, { status: 200 });
}

/** Hand a personal item to an organization, re-encrypted by the client first. */
export async function shareCipher(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherShareSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid item", 400);
    }
    const result = await ciphers.shareCipher(
        principal.userId,
        context.params.id ?? "",
        parsed.data.cipher,
        parsed.data.collectionIds
    );
    if (!result.ok) return vaultError("Not found", 404);
    return Response.json(result.cipher);
}

/**
 * Deleting, in both senses.
 *
 * Bitwarden splits them by verb rather than by path: DELETE destroys, and a PUT
 * to `.../delete` sends to the trash. The difference is passed in here rather
 * than sniffed off the URL, because "which of these is the one that cannot be
 * undone" should be visible in the route table.
 */
function deleteOne(soft: boolean): (context: VaultContext) => Promise<Response> {
    return async (context) => {
        const principal = requirePrincipal(context);
        const count = await ciphers.deleteCiphers(
            principal.userId,
            [context.params.id ?? ""],
            soft
        );
        if (count === 0) return vaultError("Not found", 404);
        return new Response(null, { status: 200 });
    };
}

function deleteMany(soft: boolean): (context: VaultContext) => Promise<Response> {
    return async (context) => {
        const principal = requirePrincipal(context);
        const parsed = core.cipherIdsSchema.safeParse(await readJsonBody(context.request));
        if (!parsed.success) return vaultError("Invalid request", 400);
        await ciphers.deleteCiphers(principal.userId, parsed.data.ids, soft);
        return new Response(null, { status: 200 });
    };
}

/** Into the trash, restorable. */
export const trashCipher = deleteOne(true);
export const trashCiphers = deleteMany(true);
/** Gone for good. */
export const destroyCipher = deleteOne(false);
export const destroyCiphers = deleteMany(false);

export async function restoreCipher(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const count = await ciphers.restoreCiphers(principal.userId, [context.params.id ?? ""]);
    if (count === 0) return vaultError("Not found", 404);
    const cipher = await ciphers.getCipher(principal.userId, context.params.id ?? "");
    return Response.json(cipher);
}

export async function restoreCiphers(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherIdsSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("Invalid request", 400);
    await ciphers.restoreCiphers(principal.userId, parsed.data.ids);
    return list(await ciphers.listCiphers(principal.userId));
}

/**
 * Move items between folders.
 *
 * Both the items and the folder they land in come from the body: the path this
 * is registered on carries no destination, and reading one off it would send
 * every move to "no folder".
 */
export async function moveCiphers(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherMoveSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("Invalid request", 400);
    await ciphers.moveCiphers(principal.userId, parsed.data.ids, parsed.data.folderId ?? null);
    return new Response(null, { status: 200 });
}

/**
 * Empty a personal vault.
 *
 * Guarded by the master password, because it is the one request in the whole API
 * that destroys everything and cannot be undone - a token alone should not be
 * enough for it.
 */
export async function purge(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.vaultVerifySchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("Invalid request", 400);
    if (!(await verifyMasterPassword(principal.userId, parsed.data.masterPasswordHash))) {
        return vaultError("Invalid master password", 400, "MasterPasswordHash");
    }
    await ciphers.purgeCiphers(principal.userId);
    return new Response(null, { status: 200 });
}

export async function listFolders(context: VaultContext): Promise<Response> {
    return list(await folders.listFolders(requirePrincipal(context).userId));
}

export async function getFolder(context: VaultContext): Promise<Response> {
    const folder = await folders.getFolder(
        requirePrincipal(context).userId,
        context.params.id ?? ""
    );
    if (!folder) return vaultError("Not found", 404);
    return Response.json(folder);
}

export async function createFolder(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.vaultFolderSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("A folder name must be encrypted.", 400);
    return Response.json(await folders.createFolder(principal.userId, parsed.data.name));
}

export async function updateFolder(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.vaultFolderSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("A folder name must be encrypted.", 400);
    const folder = await folders.updateFolder(
        principal.userId,
        context.params.id ?? "",
        parsed.data.name
    );
    if (!folder) return vaultError("Not found", 404);
    return Response.json(folder);
}

export async function deleteFolder(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    if (!(await folders.deleteFolder(principal.userId, context.params.id ?? ""))) {
        return vaultError("Not found", 404);
    }
    return new Response(null, { status: 200 });
}
