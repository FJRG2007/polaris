/**
 * The vault account: the row that says a person has a vault, how their master
 * password turns into a key, and what wrapped key material to hand back.
 *
 * Nothing here can read a vault. Every "key" column it moves around is
 * ciphertext produced in a browser, and the only secret this file owns is the
 * stretched copy of the hash a client presents to sign in.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { hashVaultPassword, newSecurityStamp, verifyVaultPassword } from "@/lib/vault/password";

/** What a client is told before it has authenticated. */
export interface PreloginAnswer extends core.KdfSettings {}

/**
 * The KDF settings for an address.
 *
 * An address with no vault gets the defaults rather than a refusal, and that is
 * a security property, not a convenience: prelogin is unauthenticated, so an
 * answer that differed for unknown addresses would turn it into a way to ask
 * whether somebody has an account here. The client then derives a key, presents
 * a hash, and is refused like any wrong password.
 */
export async function preloginFor(email: string): Promise<PreloginAnswer> {
    const account = await prisma.vaultAccount.findFirst({
        where: { user: { email: email.trim().toLowerCase() } },
        select: { kdf: true, kdfIterations: true, kdfMemory: true, kdfParallelism: true }
    });
    if (!account) return core.DEFAULT_KDF_SETTINGS;
    return {
        kdf: account.kdf as core.KdfType,
        kdfIterations: account.kdfIterations,
        kdfMemory: account.kdfMemory,
        kdfParallelism: account.kdfParallelism
    };
}

/** One account's vault, or null when they have not set one up. */
export async function getVault(userId: string) {
    return prisma.vaultAccount.findUnique({ where: { userId } });
}

/** What a browser hands over when somebody sets a vault up. */
export interface CreateVaultInput {
    /** The hash the client derived from its master key. Never the password. */
    masterPasswordHash: string;
    masterPasswordHint?: string | null;
    /** The user's key, wrapped under the stretched master key. */
    protectedKey: string;
    publicKey: string;
    /** The RSA private half, wrapped under the user's own key. */
    encryptedPrivateKey: string;
    kdf: core.KdfSettings;
}

/** Why a vault could not be created. */
export type CreateVaultResult = { ok: true } | { ok: false; reason: "exists" | "kdf" | "keys" };

/**
 * Set a vault up for an account.
 *
 * Refuses to overwrite an existing one: replacing the wrapped key would strand
 * every item already in it behind a key nothing can derive, and "set up again"
 * is not a recovery path - it is data loss with a friendly name.
 */
export async function createVault(
    userId: string,
    input: CreateVaultInput
): Promise<CreateVaultResult> {
    if (await prisma.vaultAccount.findUnique({ where: { userId }, select: { userId: true } })) {
        return { ok: false, reason: "exists" };
    }
    if (!core.kdfSettingsValid(input.kdf)) return { ok: false, reason: "kdf" };
    // The three key columns are opaque, but they must at least BE encrypted
    // strings: a client sending a plaintext key is a client with a bug, and
    // storing it would look like a working vault.
    if (
        !core.isEncString(input.protectedKey) ||
        !core.isEncString(input.encryptedPrivateKey) ||
        input.publicKey.length === 0
    ) {
        return { ok: false, reason: "keys" };
    }

    await prisma.vaultAccount.create({
        data: {
            userId,
            kdf: input.kdf.kdf,
            kdfIterations: input.kdf.kdfIterations,
            kdfMemory: input.kdf.kdfMemory,
            kdfParallelism: input.kdf.kdfParallelism,
            masterPasswordHash: await hashVaultPassword(input.masterPasswordHash),
            masterPasswordHint: input.masterPasswordHint ?? null,
            protectedKey: input.protectedKey,
            publicKey: input.publicKey,
            privateKey: input.encryptedPrivateKey,
            securityStamp: newSecurityStamp()
        }
    });
    await recordAudit({
        actorId: userId,
        action: "vault.create",
        targetType: "vault",
        targetId: userId,
        metadata: { kdf: input.kdf.kdf, iterations: input.kdf.kdfIterations }
    });
    return { ok: true };
}

/** Whether the hash a client presented matches the stored one. */
export async function verifyMasterPassword(userId: string, clientHash: string): Promise<boolean> {
    const account = await prisma.vaultAccount.findUnique({
        where: { userId },
        select: { masterPasswordHash: true }
    });
    if (!account) return false;
    return verifyVaultPassword(account.masterPasswordHash, clientHash);
}

/** What a browser sends when the master password changes. */
export interface ChangePasswordInput {
    currentHash: string;
    newHash: string;
    /** The user's key, re-wrapped under the new stretched master key. */
    newProtectedKey: string;
    masterPasswordHint?: string | null;
    /** Set only when the KDF is being changed in the same step. */
    kdf?: core.KdfSettings;
}

export type ChangePasswordResult =
    | { ok: true }
    | { ok: false; reason: "no_vault" | "wrong_password" | "kdf" | "keys" };

/**
 * Change the master password.
 *
 * The vault's own key does not change - only the wrapping around it - so nothing
 * inside has to be re-encrypted. What does change is the security stamp, and
 * with it every session on every device: a password is usually changed because
 * somebody wants the old one to stop working, and leaving live tokens behind
 * would be the one thing that undoes it.
 */
export async function changeMasterPassword(
    userId: string,
    input: ChangePasswordInput
): Promise<ChangePasswordResult> {
    const account = await prisma.vaultAccount.findUnique({
        where: { userId },
        select: { masterPasswordHash: true }
    });
    if (!account) return { ok: false, reason: "no_vault" };
    if (!(await verifyVaultPassword(account.masterPasswordHash, input.currentHash))) {
        return { ok: false, reason: "wrong_password" };
    }
    if (input.kdf && !core.kdfSettingsValid(input.kdf)) return { ok: false, reason: "kdf" };
    if (!core.isEncString(input.newProtectedKey)) return { ok: false, reason: "keys" };

    const stamp = newSecurityStamp();
    await prisma.$transaction([
        prisma.vaultAccount.update({
            where: { userId },
            data: {
                masterPasswordHash: await hashVaultPassword(input.newHash),
                protectedKey: input.newProtectedKey,
                masterPasswordHint:
                    input.masterPasswordHint === undefined ? undefined : input.masterPasswordHint,
                ...(input.kdf
                    ? {
                          kdf: input.kdf.kdf,
                          kdfIterations: input.kdf.kdfIterations,
                          kdfMemory: input.kdf.kdfMemory,
                          kdfParallelism: input.kdf.kdfParallelism
                      }
                    : {}),
                securityStamp: stamp,
                revisionDate: new Date()
            }
        }),
        // The stamp alone stops the access tokens; this stops the refresh tokens
        // that would otherwise mint new ones.
        prisma.vaultRefreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() }
        })
    ]);
    await recordAudit({
        actorId: userId,
        action: "vault.password.change",
        targetType: "vault",
        targetId: userId,
        metadata: { kdfChanged: Boolean(input.kdf) }
    });
    return { ok: true };
}

/** Move the revision date, which is how a client knows to sync. */
export async function bumpRevision(userId: string | null | undefined): Promise<void> {
    if (!userId) return;
    await prisma.vaultAccount
        .updateMany({ where: { userId }, data: { revisionDate: new Date() } })
        .catch(() => undefined);
}

/** When this vault last changed, as clients ask for before pulling. */
export async function revisionDate(userId: string): Promise<Date | null> {
    const account = await prisma.vaultAccount.findUnique({
        where: { userId },
        select: { revisionDate: true }
    });
    return account?.revisionDate ?? null;
}

/**
 * End every vault session for an account without touching its password - what
 * "deauthorize sessions" means, and what a rotation or a lost device needs.
 */
export async function deauthorizeSessions(userId: string): Promise<void> {
    const stamp = newSecurityStamp();
    await prisma.$transaction([
        prisma.vaultAccount.updateMany({ where: { userId }, data: { securityStamp: stamp } }),
        prisma.vaultRefreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() }
        })
    ]);
    await recordAudit({
        actorId: userId,
        action: "vault.deauthorize",
        targetType: "vault",
        targetId: userId
    });
}

/**
 * Delete a vault and everything in it.
 *
 * Deliberately not reachable from a client's "delete account" - that would take
 * the whole Polaris account with it. Removing the vault is its own decision, and
 * an irreversible one: the wrapped key goes with it.
 */
export async function deleteVault(userId: string): Promise<void> {
    await prisma.vaultAccount.deleteMany({ where: { userId } });
    await recordAudit({
        actorId: userId,
        action: "vault.delete",
        targetType: "vault",
        targetId: userId
    });
}
