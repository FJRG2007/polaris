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
import { verifyMasterPassword } from "@/lib/vault/account";
import * as ciphers from "@/lib/vault/ciphers";
import * as folders from "@/lib/vault/folders";
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
    return Response.json(await ciphers.createCipher(principal.userId, parsed.data));
}

/** Creating an item straight into an organization's collections. */
export async function createCipherInCollections(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.cipherCreateSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid item", 400);
    }
    return Response.json(
        await ciphers.createCipher(principal.userId, parsed.data.cipher, parsed.data.collectionIds)
    );
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
            return vaultError(
                "Somebody else changed this item. Refresh and try again.",
                409
            );
        }
        return vaultError("Not found", 404);
    }
    return Response.json(result.cipher);
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

/** Move items between folders. */
export async function moveCiphers(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const body = (await readJsonBody(context.request)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) return vaultError("Invalid request", 400);
    const folderId = context.params.folderId ?? "";
    await ciphers.moveCiphers(principal.userId, ids, folderId === "" ? null : folderId);
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
