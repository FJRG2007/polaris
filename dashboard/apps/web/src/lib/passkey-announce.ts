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

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";

/** How recently a credential must have been written for this to be the call that
 *  announces it. Long enough for a slow ceremony, short enough that it cannot be
 *  used to re-announce a passkey registered last week. */
const REGISTRATION_WINDOW_MS = 5 * 60 * 1000;

export async function announceNewPasskey(userId: string): Promise<void> {
    const newest = await prisma.passkey.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, createdAt: true }
    });
    if (!newest || Date.now() - newest.createdAt.getTime() > REGISTRATION_WINDOW_MS) return;

    const announced = await prisma.auditLog.findFirst({
        where: { actorId: userId, action: "account.passkey.added", targetId: newest.id },
        select: { id: true }
    });
    if (announced) return;

    await recordAudit({
        actorId: userId,
        action: "account.passkey.added",
        targetType: "passkey",
        targetId: newest.id,
        metadata: newest.name ? { name: newest.name } : undefined
    });
}
