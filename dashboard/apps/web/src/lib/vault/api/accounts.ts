/**
 * The account endpoints: who the client is, what keys it holds, and the two
 * changes a client can make to its own credentials.
 *
 * Nothing here can read a vault, and the password endpoints are careful about
 * that: changing a master password re-wraps the vault key in the browser and
 * sends the new wrapping, so what arrives is a value the server stores rather
 * than a value it computes. Refusing a bad one is the whole of its job.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as account from "@/lib/vault/account";
import { profileFor, syncResponse } from "@/lib/vault/sync";
import { vaultError, type VaultPrincipal } from "@/lib/vault/auth";
import { readJsonBody, requirePrincipal, type VaultContext } from "@/lib/vault/api/router";

/** The KDF settings out of a request body, or the account's current ones. */
function kdfFrom(
    body: {
        kdf?: number;
        kdfIterations?: number;
        kdfMemory?: number | null;
        kdfParallelism?: number | null;
    },
    current: core.KdfSettings
): core.KdfSettings {
    if (body.kdf === undefined || body.kdfIterations === undefined) return current;
    return {
        kdf: body.kdf as core.KdfType,
        kdfIterations: body.kdfIterations,
        kdfMemory: body.kdfMemory ?? null,
        kdfParallelism: body.kdfParallelism ?? null
    };
}

export async function getProfile(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const profile = await profileFor(principal.userId);
    if (!profile) return vaultError("This account has no vault.", 404);
    return Response.json(profile);
}

export async function getSync(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const sync = await syncResponse(principal.userId);
    if (!sync) return vaultError("This account has no vault.", 404);
    return Response.json(sync);
}

/** When this vault last changed, which is all a client needs to skip a sync. */
export async function getRevisionDate(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const revision = await account.revisionDate(principal.userId);
    // Milliseconds as a bare number: what clients parse here, not an object.
    return new Response(String(revision?.getTime() ?? 0), {
        headers: { "content-type": "application/json" }
    });
}

/** The keys an organization needs to share with this account. */
export async function getKeys(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const row = await prisma.vaultAccount.findUnique({
        where: { userId: principal.userId },
        select: { publicKey: true, privateKey: true }
    });
    if (!row) return vaultError("This account has no vault.", 404);
    return Response.json({
        object: "keys",
        publicKey: row.publicKey,
        privateKey: row.privateKey
    });
}

/** Somebody else's public key, so this client can wrap something to them. */
export async function getUserPublicKey(context: VaultContext): Promise<Response> {
    requirePrincipal(context);
    const row = await prisma.vaultAccount.findUnique({
        where: { userId: context.params.id ?? "" },
        select: { userId: true, publicKey: true }
    });
    // A public key is public, but only to somebody already signed in: an open
    // endpoint here would confirm which accounts have vaults.
    if (!row?.publicKey) return vaultError("Not found", 404);
    return Response.json({ object: "userKey", userId: row.userId, publicKey: row.publicKey });
}

/** Prove the master password again, for a screen that asks a second time. */
export async function verifyPassword(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.vaultVerifySchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) return vaultError("Invalid request", 400);
    const valid = await account.verifyMasterPassword(
        principal.userId,
        parsed.data.masterPasswordHash
    );
    if (!valid) return vaultError("Invalid master password", 400, "MasterPasswordHash");
    return new Response(null, { status: 200 });
}

/**
 * Change the master password.
 *
 * Also the endpoint a KDF change comes through, because a client that changes
 * its KDF has to re-derive and re-wrap in the same step - splitting them would
 * leave a window where the stored wrapping does not match the stored settings,
 * and nothing could open the vault.
 */
export async function changePassword(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.vaultPasswordSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
    }
    const current = await account.getVault(principal.userId);
    if (!current) return vaultError("This account has no vault.", 404);

    const result = await account.changeMasterPassword(principal.userId, {
        currentHash: parsed.data.masterPasswordHash,
        newHash: parsed.data.newMasterPasswordHash,
        newProtectedKey: parsed.data.key,
        masterPasswordHint: parsed.data.masterPasswordHint ?? undefined,
        kdf: kdfFrom(parsed.data, {
            kdf: current.kdf as core.KdfType,
            kdfIterations: current.kdfIterations,
            kdfMemory: current.kdfMemory,
            kdfParallelism: current.kdfParallelism
        })
    });
    if (!result.ok) {
        if (result.reason === "wrong_password") {
            return vaultError("Invalid master password", 400, "MasterPasswordHash");
        }
        if (result.reason === "kdf") return vaultError("Those settings are out of range.", 400);
        return vaultError("Invalid request", 400);
    }
    return new Response(null, { status: 200 });
}

/** End every vault session without changing the password. */
export async function deauthorize(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    await account.deauthorizeSessions(principal.userId);
    return new Response(null, { status: 200 });
}

/**
 * What a client asks for when it wants to know which second factors it may be
 * challenged with. Read-only: arming and removing a factor happens in Polaris,
 * on the account, because it is the account's factor and not the vault's.
 */
export async function listTwoFactor(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const user = await prisma.user.findUnique({
        where: { id: principal.userId },
        select: { twoFactorEnabled: true }
    });
    return Response.json({
        object: "list",
        continuationToken: null,
        data: user?.twoFactorEnabled
            ? [{ object: "twoFactorProvider", enabled: true, type: core.TWO_FACTOR_AUTHENTICATOR }]
            : []
    });
}

/** The devices signed in to this vault, so their owner can recognize them. */
export async function listDevices(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const rows = await prisma.vaultDevice.findMany({
        where: { userId: principal.userId },
        orderBy: { revisionDate: "desc" },
        select: {
            id: true,
            identifier: true,
            name: true,
            type: true,
            createdAt: true,
            revisionDate: true
        }
    });
    return Response.json({
        object: "list",
        continuationToken: null,
        data: rows.map((row) => ({
            object: "device",
            id: row.id,
            identifier: row.identifier,
            name: row.name,
            type: row.type,
            creationDate: row.createdAt.toISOString(),
            revisionDate: row.revisionDate.toISOString()
        }))
    });
}

/** One device by the identifier it gave itself, which is how clients look
 *  themselves up before deciding whether they are known here. */
export async function getDeviceByIdentifier(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const row = await prisma.vaultDevice.findUnique({
        where: {
            userId_identifier: {
                userId: principal.userId,
                identifier: context.params.identifier ?? ""
            }
        },
        select: { id: true, identifier: true, name: true, type: true }
    });
    if (!row) return vaultError("Not found", 404);
    return Response.json({
        object: "device",
        id: row.id,
        identifier: row.identifier,
        name: row.name,
        type: row.type
    });
}

/** Record a push token for a device. Accepted and stored; Polaris does not run
 *  a push service, so nothing reads it yet, and refusing would make clients
 *  report a failure for something that is not one. */
export async function putDeviceToken(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const body = (await readJsonBody(context.request)) as { pushToken?: unknown } | null;
    const token = typeof body?.pushToken === "string" ? body.pushToken : null;
    await prisma.vaultDevice.updateMany({
        where: { userId: principal.userId, identifier: context.params.identifier ?? "" },
        data: { pushToken: token }
    });
    return new Response(null, { status: 200 });
}

/** Set up a vault from a client rather than from the Polaris screens. */
export async function createVaultFromClient(
    principal: VaultPrincipal,
    body: unknown
): Promise<Response> {
    const parsed = core.vaultRegisterSchema.safeParse(body);
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid request", 400);
    }
    const result = await account.createVault(principal.userId, {
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
        if (result.reason === "exists") return vaultError("This account already has a vault.", 400);
        if (result.reason === "kdf") return vaultError("Those settings are out of range.", 400);
        return vaultError("Those keys are not encrypted values.", 400);
    }
    return new Response(null, { status: 200 });
}
