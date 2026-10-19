/**
 * What the Cloud servers app needs from the dashboard: a credential sealed with
 * the master key, an enrollment for a machine it is about to create, that
 * enrollment's progress, and taking an enrolled server out of Polaris again.
 *
 * Each function is one of the dashboard's own services narrowed to the question
 * the app asks, so `lib/app-host/server.ts` hands over these and not the modules
 * behind them. A created machine enrolls exactly the way one added by hand does:
 * the same token, the same script, the same host-key pinning.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import {
    managedConnectionOrgs,
    managesOrgConnections,
    orgActorFor,
    type ManagedConnectionOrg
} from "@/lib/connections/org-scope";
import type { SealedSecret } from "@/lib/calendar-host";
import { removeServer } from "@/lib/server-removal-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { getEnrollmentStatus, openEnrollment } from "@/lib/enrollment-service";

/** The organizations this account may connect cloud accounts for, by name. */
export async function cloudConnectionOrgs(userId: string): Promise<ManagedConnectionOrg[]> {
    return managedConnectionOrgs(await orgActorFor(userId));
}

/** Whether this account may connect, use and remove one organization's cloud
 *  accounts: the same check the organization's Connections screen draws from. */
export async function managesCloudOrg(userId: string, orgId: string): Promise<boolean> {
    return managesOrgConnections(await orgActorFor(userId), orgId);
}

/**
 * Before an account is deleted: the cloud accounts it connected for an
 * organization pass to that organization's owner. They are the organization's,
 * and its servers may still be running at them, so they outlive the person who
 * happened to connect them. An organization this account owns goes with it.
 */
export async function handOverOrgCloudAccounts(userId: string): Promise<void> {
    for (;;) {
        const accounts = await prisma.cloudAccount.findMany({
            where: {
                ownerId: userId,
                organization: { ownerId: { not: userId } }
            },
            select: { id: true, organization: { select: { ownerId: true } } },
            take: 500
        });
        if (accounts.length === 0) return;
        const byOwner = new Map<string, string[]>();
        for (const account of accounts) {
            const owner = account.organization!.ownerId;
            byOwner.set(owner, [...(byOwner.get(owner) ?? []), account.id]);
        }
        await prisma.$transaction(
            [...byOwner].map(([ownerId, ids]) =>
                prisma.cloudAccount.updateMany({ where: { id: { in: ids } }, data: { ownerId } })
            )
        );
    }
}

/** Seal a provider credential for storage. */
export async function sealCloudSecret(secret: string): Promise<SealedSecret> {
    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

/** The stored credential, or null when the master key it was sealed under is
 *  gone - which reads as "connect the account again". */
export async function openCloudSecret(sealed: {
    readonly encryptedSecret: Uint8Array;
    readonly secretNonce: Uint8Array;
    readonly secretKeyId: string;
}): Promise<string | null> {
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(sealed.encryptedSecret),
                nonce: Buffer.from(sealed.secretNonce),
                keyId: sealed.secretKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

/** A machine about to be created, as the enrollment it will claim. */
export interface CloudEnrollment {
    readonly id: string;
    /** The command the machine runs as root on first boot. */
    readonly command: string;
    readonly expiresAt: string;
}

/** Open an enrollment for a cloud machine. The command it carries is what the
 *  machine's first-boot script runs. */
export async function openCloudEnrollment(userId: string, name: string): Promise<CloudEnrollment> {
    const opened = await openEnrollment(userId, { kind: "server", name, environment: "cloud" });
    return { id: opened.id, command: opened.command, expiresAt: opened.expiresAt };
}

/** Where an enrollment stands: claimed (with the server it became), waiting, or
 *  failed with the reason the machine reported. */
export async function cloudEnrollmentStatus(
    enrollmentId: string,
    userId: string
): Promise<{ hostId: string | null; error: string | null; expired: boolean } | null> {
    const status = await getEnrollmentStatus(enrollmentId, userId);
    if (!status) return null;
    return {
        hostId: status.hostId,
        error: status.state === "failed" ? status.error : null,
        expired: status.state === "expired"
    };
}

/** Take a destroyed machine out of Polaris. Nothing is done on the machine: it
 *  is already gone. `ownerId` is whoever enrolled it; `actorId` whoever asked. */
export async function removeCloudHost(
    ownerId: string,
    hostId: string,
    actorId: string = ownerId
): Promise<string | null> {
    const result = await removeServer(ownerId, hostId, actorId, { mode: "disconnect" });
    return result.error ?? null;
}
