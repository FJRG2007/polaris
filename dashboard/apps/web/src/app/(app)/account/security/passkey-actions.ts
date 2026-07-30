"use server";

/**
 * Listing and removing the passkeys on the signed-in account.
 *
 * Registering one is not here on purpose: the credential is created by the
 * browser through the passkey client, and routing it through a server action
 * would mean handling WebAuthn material Polaris has no reason to touch.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { passkeyRelyingPartyId } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { requireUser } from "@/lib/session";

export interface PasskeyView {
    id: string;
    name: string;
    /** The address it signs in on. WebAuthn binds a credential to exactly one. */
    host: string;
    /** ISO timestamp; the card renders it in the reader's locale. */
    addedAt: string;
}

/**
 * The signed-in user's passkeys, oldest first. Never returns the credential
 * itself. Resolves the session rather than taking a user id: everything in a
 * "use server" module is a callable endpoint, so an id from the caller would be
 * an invitation to read someone else's.
 */
export async function listPasskeys(): Promise<PasskeyView[]> {
    const user = await requireUser();
    const rows = await prisma.passkey.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, rpId: true, createdAt: true }
    });
    // Rows from before passkeys followed the address carry none: every one of
    // them was issued under the published app URL.
    const published = passkeyRelyingPartyId(loadEnv().POLARIS_APP_URL) ?? "";
    return rows.map((row) => ({
        id: row.id,
        name: row.name?.trim() || "Unnamed passkey",
        host: row.rpId ?? published,
        addedAt: row.createdAt.toISOString()
    }));
}

export async function removePasskeyAction(passkeyId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    if (typeof passkeyId !== "string") return { error: "Unknown passkey." };
    // Scoped to the owner, so an id from somewhere else deletes nothing.
    const removed = await prisma.passkey.deleteMany({ where: { id: passkeyId, userId: user.id } });
    if (removed.count === 0) return { error: "That passkey is no longer on your account." };
    await recordAudit({ actorId: user.id, action: "account.passkey.removed", targetType: "passkey" });
    return {};
}
