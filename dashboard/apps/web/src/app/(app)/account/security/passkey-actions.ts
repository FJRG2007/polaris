"use server";

/**
 * Listing and removing the passkeys on the signed-in account, and the password
 * confirmation that has to come before a new one is registered.
 *
 * Registering one is not here on purpose: the credential is created by the
 * browser through the passkey client, and routing it through a server action
 * would mean handling WebAuthn material Polaris has no reason to touch. What is
 * here is the step before it - proving the password - because the ceremony
 * itself only ever proves the device, and an open session on a borrowed screen
 * was otherwise enough to attach a permanent way in.
 */

import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { getTranslations } from "@/lib/i18n/request";
import { localized } from "./action-messages";
import { confirmAccountPassword } from "@polaris/auth";
import { listUserPasskeys, type PasskeyView } from "@/lib/passkey-directory";
import { announceNewPasskey } from "@/lib/passkey-announce";
import { phishingResistantRequiredFor } from "@/lib/instance-security";

/**
 * The signed-in user's passkeys, oldest first. Resolves the session rather than
 * taking a user id: everything in a "use server" module is a callable endpoint,
 * so an id from the caller would be an invitation to read someone else's.
 */
export async function listPasskeys(): Promise<PasskeyView[]> {
    const user = await requireUser();
    return listUserPasskeys(user.id);
}

/**
 * Prove the account password, so the registration ceremony that follows is
 * allowed to start.
 *
 * The proof is kept against the session for a few minutes rather than handed
 * back, so nothing the browser holds can be replayed as one, and a prompt the
 * user dismissed and reopened does not ask again.
 */
export async function confirmPasswordForPasskeyAction(
    password: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const ok = await confirmAccountPassword(auth, user.id, user.sessionId, String(password ?? ""));
    if (!ok) return { error: (await getTranslations("accountSecurity"))("known.wrongPassword") };
    return {};
}

/** Log and announce the passkey just registered, once (see `announceNewPasskey`). */
export async function notePasskeyAddedAction(): Promise<void> {
    const user = await requireUser();
    await announceNewPasskey(user.id);
}

export async function removePasskeyAction(passkeyId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    if (typeof passkeyId !== "string")
        return { error: (await getTranslations("accountSecurity"))("errors.unknownPasskey") };
    // Scoped to the owner, so an id from somewhere else deletes nothing.
    const passkey = await prisma.passkey.findFirst({
        where: { id: passkeyId, userId: user.id },
        select: { credentialID: true }
    });
    let removed: { count: number };
    if (passkey && (await phishingResistantRequiredFor(user.id))) {
        // The instance requires this account to sign in with a passkey or a
        // security key, so its last one cannot go: without it the next sign-in
        // could not meet the requirement. Serializable, so two removals racing
        // over the last two cannot both see one left.
        const kept = await prisma
            .$transaction(
                async (tx) => {
                    const count = await tx.passkey.count({ where: { userId: user.id } });
                    if (count <= 1) return null;
                    const result = await tx.passkey.deleteMany({ where: { id: passkeyId, userId: user.id } });
                    await tx.vaultPasskey.deleteMany({
                        where: { userId: user.id, credentialId: passkey.credentialID }
                    });
                    return result;
                },
                { isolationLevel: "Serializable" }
            )
            .catch(() => undefined);
        const t = await getTranslations("accountSecurity");
        if (kept === null) return { error: t("errors.lastRequiredPasskey") };
        if (kept === undefined) return { error: t("errors.passkeyRetry") };
        removed = kept;
    } else {
        [removed] = await prisma.$transaction([
            prisma.passkey.deleteMany({ where: { id: passkeyId, userId: user.id } }),
            prisma.vaultPasskey.deleteMany({
                where: passkey
                    ? { userId: user.id, credentialId: passkey.credentialID }
                    : { id: { in: [] } }
            })
        ]);
    }
    if (removed.count === 0)
        return { error: (await getTranslations("accountSecurity"))("errors.passkeyGone") };
    await recordAudit({
        actorId: user.id,
        action: "account.passkey.removed",
        targetType: "passkey"
    });
    return {};
}
