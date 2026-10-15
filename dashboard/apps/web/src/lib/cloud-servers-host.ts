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

import { loadEnv } from "@polaris/config";
import type { SealedSecret } from "@/lib/calendar-host";
import { removeServer } from "@/lib/server-removal-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { getEnrollmentStatus, openEnrollment } from "@/lib/enrollment-service";

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
 *  is already gone. */
export async function removeCloudHost(userId: string, hostId: string): Promise<string | null> {
    const result = await removeServer(userId, hostId, userId, { mode: "disconnect" });
    return result.error ?? null;
}
