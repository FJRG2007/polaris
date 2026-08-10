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
import { confirmAccountPassword } from "@polaris/auth";
import { listUserPasskeys, type PasskeyView } from "@/lib/passkey-directory";

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
export async function confirmPasswordForPasskeyAction(password: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const ok = await confirmAccountPassword(auth, user.id, user.sessionId, String(password ?? ""));
    if (!ok) return { error: "Current password is incorrect." };
    return {};
}

/** How recently a credential must have been written for this to be the call that
 *  announces it. Long enough for a slow ceremony, short enough that it cannot be
 *  used to re-announce a passkey registered last week. */
const REGISTRATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Record that a passkey was registered, once the browser's ceremony has
 * finished.
 *
 * A permanent way into the account is being created, so the owner is told - but
 * the credential itself is written by better-auth from the client, which leaves
 * nothing on the server to hang that on. So the client says it is done and the
 * server checks: it announces the newest passkey on the account, only while it
 * is newly written, and only if it has not been announced already. A caller that
 * says this without registering anything therefore gets nothing, and a caller
 * that says it twice gets one alert.
 */
export async function notePasskeyAddedAction(): Promise<void> {
    const user = await requireUser();
    const newest = await prisma.passkey.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, createdAt: true }
    });
    if (!newest || Date.now() - newest.createdAt.getTime() > REGISTRATION_WINDOW_MS) return;

    const announced = await prisma.auditLog.findFirst({
        where: { actorId: user.id, action: "account.passkey.added", targetId: newest.id },
        select: { id: true }
    });
    if (announced) return;

    await recordAudit({
        actorId: user.id,
        action: "account.passkey.added",
        targetType: "passkey",
        targetId: newest.id,
        metadata: newest.name ? { name: newest.name } : undefined
    });
}

export async function removePasskeyAction(passkeyId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    if (typeof passkeyId !== "string") return { error: "Unknown passkey." };
    // Scoped to the owner, so an id from somewhere else deletes nothing.
    const removed = await prisma.passkey.deleteMany({ where: { id: passkeyId, userId: user.id } });
    if (removed.count === 0) return { error: "That passkey is no longer on your account." };
    await recordAudit({ actorId: user.id, action: "account.passkey.removed", targetType: "passkey" });
    return {};
}
