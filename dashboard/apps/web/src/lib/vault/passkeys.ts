/**
 * Passkeys that unlock a vault, on the server side - which is to say storage,
 * proof of who is asking, a rate limit and an audit row. Nothing here can open
 * anything: the server holds the wrapped key, the credential id and the PRF
 * salt, and the PRF output that turns those into the vault key never leaves the
 * authenticator and the tab that asked it.
 *
 * There is no such thing as a vault passkey of its own. The vault is unlocked
 * with the account's sign-in passkeys (the `Passkey` table), each turned on or
 * off here - what Bitwarden does with "log in with passkey", and it means one
 * entry in somebody's password manager, not two that look identical. A row
 * here is only the wrap; the name, the address and the device type are read
 * from the `Passkey` row it names, so renaming a passkey on the security page
 * renames it here too.
 *
 * Turning one on asks for the account's step-up proof, held for two minutes
 * (`step-up-grant`), rather than the master password: the tab already holds the
 * vault key, so what is in question is whether the person at it may give the
 * vault another way in, and that is what the step-up gate answers everywhere
 * else in Polaris.
 *
 * A wrap holds the vault key itself, not the master key, so changing the
 * master password here (which re-wraps that same vault key) leaves every
 * passkey working with nothing to redo. A change made from a Bitwarden-compatible
 * client cannot vouch for that, so it removes every row and they are turned on
 * again. The vault key otherwise only changes when the vault is deleted and made
 * again, and the rows here cascade away with the old one.
 *
 * A row only answers while its credential is still one of the account's sign-in
 * passkeys: removing that passkey removes the row, and every read here leaves
 * out a row whose passkey went another way.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { stepUpGranted } from "@/lib/step-up-grant";
import { rateLimit } from "@/lib/rate-limit-service";
import { passkeyHostReader } from "@/lib/passkey-directory";
import {
    VAULT_PASSKEYS_MAX,
    type VaultPasskeyChoice,
    type VaultPasskeyEnrollInput,
    type VaultPasskeyEntry
} from "@/lib/vault/passkey-schema";

/** Turns on and off one account may make in a window. */
const CHANGES_PER_WINDOW = 10;
const CHANGE_WINDOW_MS = 15 * 60 * 1000;

/** Sign-in passkeys read per account. Far past what anybody registers. */
const ACCOUNT_PASSKEYS_READ = 50;

export type PasskeyChangeResult =
    | { ok: true }
    | {
          ok: false;
          reason: "rate_limited" | "needs_proof" | "not_your_passkey" | "too_many" | "not_found";
          retryAfterMs?: number;
      };

/** The account's sign-in passkeys, oldest first, with what the vault reads off them. */
async function accountPasskeys(userId: string) {
    return prisma.passkey.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take: ACCOUNT_PASSKEYS_READ,
        select: {
            id: true,
            name: true,
            deviceType: true,
            createdAt: true,
            credentialID: true,
            rpId: true
        }
    });
}

/** The passkeys that unlock this account's vault, for the lock screen. */
export async function listVaultPasskeys(userId: string): Promise<VaultPasskeyEntry[]> {
    const passkeys = await accountPasskeys(userId);
    const hostOf = passkeyHostReader();
    const rpIds = new Map(passkeys.map((row) => [row.credentialID, hostOf(row.rpId)]));
    const rows = await prisma.vaultPasskey.findMany({
        where: { userId, credentialId: { in: [...rpIds.keys()] } },
        orderBy: { createdAt: "asc" },
        take: VAULT_PASSKEYS_MAX,
        select: { id: true, credentialId: true, prfSalt: true, wrappedKey: true }
    });
    return rows.map((row) => ({ ...row, rpId: rpIds.get(row.credentialId) ?? "" }));
}

/**
 * Every sign-in passkey on the account, each with whether it unlocks the vault,
 * for the settings card. Two reads, never one per passkey.
 */
export async function listVaultPasskeyChoices(userId: string): Promise<VaultPasskeyChoice[]> {
    const passkeys = await accountPasskeys(userId);
    if (passkeys.length === 0) return [];
    const rows = await prisma.vaultPasskey.findMany({
        where: { userId, credentialId: { in: passkeys.map((row) => row.credentialID) } },
        take: VAULT_PASSKEYS_MAX,
        select: { id: true, credentialId: true, lastUsedAt: true }
    });
    const enrolled = new Map(rows.map((row) => [row.credentialId, row]));
    const hostOf = passkeyHostReader();
    return passkeys.map((row) => {
        const vault = enrolled.get(row.credentialID);
        return {
            passkeyId: row.id,
            name: row.name?.trim() || null,
            deviceType: row.deviceType,
            addedAt: row.createdAt.toISOString(),
            credentialId: row.credentialID,
            rpId: hostOf(row.rpId),
            vault: vault
                ? { id: vault.id, lastUsedAt: vault.lastUsedAt?.toISOString() ?? null }
                : null
        };
    });
}

async function underLimit(userId: string): Promise<PasskeyChangeResult | null> {
    const allowed = await rateLimit(
        `vault-passkey:${userId}`,
        CHANGES_PER_WINDOW,
        CHANGE_WINDOW_MS
    );
    return allowed.ok
        ? null
        : { ok: false, reason: "rate_limited", retryAfterMs: allowed.retryAfterMs };
}

/**
 * Let one of the account's passkeys unlock this vault. Whoever is sitting at an
 * unlocked tab has the vault key, but not necessarily the right to give it a
 * second way in - so this session has to have passed the step-up proof for it
 * within the last two minutes.
 */
export async function enrollVaultPasskey(
    userId: string,
    sessionId: string,
    input: VaultPasskeyEnrollInput
): Promise<PasskeyChangeResult> {
    const limited = await underLimit(userId);
    if (limited) return limited;
    if (!(await stepUpGranted(userId, sessionId, "vault-passkeys"))) {
        return { ok: false, reason: "needs_proof" };
    }
    const owned = await prisma.passkey.findFirst({
        where: { userId, credentialID: input.credentialId },
        select: { id: true, name: true }
    });
    if (!owned) return { ok: false, reason: "not_your_passkey" };

    const existing = await prisma.vaultPasskey.findUnique({
        where: { userId_credentialId: { userId, credentialId: input.credentialId } },
        select: { id: true }
    });
    if (
        !existing &&
        (await prisma.vaultPasskey.count({ where: { userId } })) >= VAULT_PASSKEYS_MAX
    ) {
        return { ok: false, reason: "too_many" };
    }
    const data = { prfSalt: input.prfSalt, wrappedKey: input.wrappedKey };
    // The same credential turned on again replaces its wrap rather than adding a
    // second row that would answer to the same passkey.
    const row = await prisma.vaultPasskey.upsert({
        where: { userId_credentialId: { userId, credentialId: input.credentialId } },
        create: { userId, credentialId: input.credentialId, ...data },
        update: data,
        select: { id: true }
    });
    // Which passkey, never the salt or the wrap.
    await recordAudit({
        actorId: userId,
        action: "vault.passkey.added",
        targetType: "vaultPasskey",
        targetId: row.id,
        metadata: { passkeyId: owned.id, name: owned.name }
    });
    return { ok: true };
}

/** Stop a passkey unlocking this vault. It still signs in, and the master password still opens it. */
export async function removeVaultPasskey(userId: string, id: string): Promise<PasskeyChangeResult> {
    const limited = await underLimit(userId);
    if (limited) return limited;
    const row = await prisma.vaultPasskey.findFirst({
        where: { id, userId },
        select: { id: true, credentialId: true }
    });
    if (!row) return { ok: false, reason: "not_found" };
    await prisma.vaultPasskey.deleteMany({ where: { id, userId } });
    const passkey = await prisma.passkey.findFirst({
        where: { userId, credentialID: row.credentialId },
        select: { id: true, name: true }
    });
    await recordAudit({
        actorId: userId,
        action: "vault.passkey.removed",
        targetType: "vaultPasskey",
        targetId: row.id,
        metadata: { passkeyId: passkey?.id ?? null, name: passkey?.name ?? null }
    });
    return { ok: true };
}

/** When a passkey last opened the vault, as the tab that opened it reports. */
export async function markVaultPasskeyUsed(userId: string, id: string): Promise<void> {
    await prisma.vaultPasskey.updateMany({
        where: { id, userId },
        data: { lastUsedAt: new Date() }
    });
}
