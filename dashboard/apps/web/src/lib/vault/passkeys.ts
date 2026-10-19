/**
 * Passkeys that unlock a vault, on the server side - which is to say storage,
 * proof of who is asking, a rate limit and an audit row. Nothing here can open
 * anything: the server holds the wrapped key, the credential id and the PRF
 * salt, and the PRF output that turns those into the vault key never leaves the
 * authenticator and the tab that asked it.
 *
 * The credential is one of the account's own sign-in passkeys rather than a
 * second one minted for the vault. That is what Bitwarden does with "log in
 * with passkey", and it means one entry in somebody's password manager, not two
 * that look identical. Enrolling checks the credential id against the account's
 * `Passkey` rows so a passkey of another account on the same machine cannot be
 * wrapped into this vault by mistake.
 *
 * A wrap holds the vault key itself, not the master key, so changing the
 * master password here (which re-wraps that same vault key) leaves every
 * passkey working with nothing to redo. A change made from a Bitwarden-compatible
 * client cannot vouch for that, so it removes every passkey and they are added
 * again. The vault key otherwise only changes when the vault is deleted and made
 * again, and the rows here cascade away with the old one.
 *
 * A row only answers while its credential is still one of the account's sign-in
 * passkeys: removing that passkey removes the row, and the list leaves out any
 * row whose passkey went another way.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { verifyMasterPassword } from "@/lib/vault/account";
import { VAULT_PASSKEYS_MAX, type VaultPasskeyEnrollInput, type VaultPasskeyEntry } from "@/lib/vault/passkey-schema";

/** Enrolls and removals one account may make in a window. */
const CHANGES_PER_WINDOW = 10;
const CHANGE_WINDOW_MS = 15 * 60 * 1000;

export type PasskeyChangeResult =
    | { ok: true }
    | {
          ok: false;
          reason: "rate_limited" | "wrong_password" | "not_your_passkey" | "too_many" | "not_found";
          retryAfterMs?: number;
      };

/** The passkeys that unlock this account's vault, oldest first. */
export async function listVaultPasskeys(userId: string): Promise<VaultPasskeyEntry[]> {
    const rows = await prisma.vaultPasskey.findMany({
        where: { userId, credentialId: { in: await signInCredentialIds(userId) } },
        orderBy: { createdAt: "asc" },
        take: VAULT_PASSKEYS_MAX,
        select: {
            id: true,
            name: true,
            credentialId: true,
            rpId: true,
            prfSalt: true,
            wrappedKey: true,
            createdAt: true,
            lastUsedAt: true
        }
    });
    return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null
    }));
}

/** The credential ids of this account's sign-in passkeys, which are the ones a vault may use. */
export async function signInCredentialIds(userId: string): Promise<string[]> {
    const rows = await prisma.passkey.findMany({
        where: { userId },
        select: { credentialID: true },
        take: 50
    });
    return rows.map((row) => row.credentialID);
}

async function underLimit(userId: string): Promise<PasskeyChangeResult | null> {
    const allowed = await rateLimit(`vault-passkey:${userId}`, CHANGES_PER_WINDOW, CHANGE_WINDOW_MS);
    return allowed.ok ? null : { ok: false, reason: "rate_limited", retryAfterMs: allowed.retryAfterMs };
}

/**
 * Let a passkey unlock this vault. The master password hash is checked first:
 * whoever is sitting at an unlocked tab has the vault key, but not necessarily
 * the right to give it a second way in.
 */
export async function enrollVaultPasskey(
    userId: string,
    input: VaultPasskeyEnrollInput
): Promise<PasskeyChangeResult> {
    const limited = await underLimit(userId);
    if (limited) return limited;
    if (!(await verifyMasterPassword(userId, input.masterPasswordHash))) {
        return { ok: false, reason: "wrong_password" };
    }
    const owned = await prisma.passkey.findFirst({
        where: { userId, credentialID: input.credentialId },
        select: { id: true }
    });
    if (!owned) return { ok: false, reason: "not_your_passkey" };

    const existing = await prisma.vaultPasskey.findUnique({
        where: { userId_credentialId: { userId, credentialId: input.credentialId } },
        select: { id: true }
    });
    if (!existing && (await prisma.vaultPasskey.count({ where: { userId } })) >= VAULT_PASSKEYS_MAX) {
        return { ok: false, reason: "too_many" };
    }
    const data = {
        rpId: input.rpId,
        prfSalt: input.prfSalt,
        wrappedKey: input.wrappedKey,
        name: input.name
    };
    // The same credential enrolled again replaces its wrap rather than adding a
    // second row that would answer to the same passkey.
    const row = await prisma.vaultPasskey.upsert({
        where: { userId_credentialId: { userId, credentialId: input.credentialId } },
        create: { userId, credentialId: input.credentialId, ...data },
        update: data,
        select: { id: true }
    });
    // The name and the address, never the salt or the wrap.
    await recordAudit({
        actorId: userId,
        action: "vault.passkey.added",
        targetType: "vaultPasskey",
        targetId: row.id,
        metadata: { name: input.name, rpId: input.rpId }
    });
    return { ok: true };
}

/** Stop a passkey unlocking this vault. The master password still does. */
export async function removeVaultPasskey(userId: string, id: string): Promise<PasskeyChangeResult> {
    const limited = await underLimit(userId);
    if (limited) return limited;
    const row = await prisma.vaultPasskey.findFirst({
        where: { id, userId },
        select: { id: true, name: true, rpId: true }
    });
    if (!row) return { ok: false, reason: "not_found" };
    await prisma.vaultPasskey.deleteMany({ where: { id, userId } });
    await recordAudit({
        actorId: userId,
        action: "vault.passkey.removed",
        targetType: "vaultPasskey",
        targetId: row.id,
        metadata: { name: row.name, rpId: row.rpId }
    });
    return { ok: true };
}

/** When a passkey last opened the vault, as the tab that opened it reports. */
export async function markVaultPasskeyUsed(userId: string, id: string): Promise<void> {
    await prisma.vaultPasskey.updateMany({ where: { id, userId }, data: { lastUsedAt: new Date() } });
}
