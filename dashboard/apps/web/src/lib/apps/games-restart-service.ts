/**
 * Carrying out the restart somebody asked for later.
 *
 * The request is recorded on the install; this is what comes back to it. Every
 * poll of a game server's own page and every cron walk passes through here with
 * the player count it has already paid for, so a restart booked for "when nobody
 * is playing" happens within a poll of the last person leaving, without anybody
 * watching the screen.
 *
 * The world is saved first, always. A restart that lost the last few minutes of
 * everybody's evening because a settings change was waiting is not a trade
 * anybody agreed to, and both games can be told to write the world to disk.
 */

import { prisma } from "@polaris/db";
import { gameOfServer } from "@/lib/apps/games-catalog";
import { deployApplication } from "@/lib/deploy-service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import {
    PENDING_RESTART_KEY,
    newPendingRestart,
    readPendingRestart,
    restartDue,
    type PendingRestart,
    type RestartWhen
} from "@/lib/apps/games-restart";

/** The restart this server is waiting on, or null. */
export async function readRestartRequest(installedAppId: string): Promise<PendingRestart | null> {
    const install = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return readPendingRestart(readInstallConfig(install?.config));
}

/** Ask for one. Replaces whatever was asked for before: there is one server and
 *  one plan for it. */
export async function requestRestart(
    installedAppId: string,
    input: { when: RestartWhen; at?: string | null; reason?: string; requestedBy: string }
): Promise<PendingRestart> {
    const pending = newPendingRestart({ ...input, now: new Date() });
    if (!pending) throw new Error("Pick a time in the next few weeks");
    await patchInstallConfig(installedAppId, { [PENDING_RESTART_KEY]: pending });
    return pending;
}

/** Call it off. The change it was going to apply still applies at the next start,
 *  whenever that is. */
export async function cancelRestart(installedAppId: string): Promise<void> {
    await patchInstallConfig(installedAppId, { [PENDING_RESTART_KEY]: null });
}

/**
 * Restart it now, saving the world on the way down.
 *
 * The same two steps the booked restart takes, so the immediate button and the one
 * that fires at four in the morning cannot drift apart. Throws, unlike the sweep:
 * somebody is watching this one and is owed the reason.
 */
export async function runRestartNow(
    ownerId: string,
    installedAppId: string,
    actorId: string
): Promise<void> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true }
    });
    if (!install?.applicationId) throw new Error("This server has not been deployed yet");
    await saveWorld(ownerId, installedAppId, install.catalogId);
    await deployApplication(install.applicationId, ownerId, actorId);
    // Whatever was booked for later has just happened.
    await patchInstallConfig(installedAppId, { [PENDING_RESTART_KEY]: null });
}

/**
 * Restart the server if the moment it was booked for has arrived.
 *
 * Never throws: every caller is a poll or a sweep. A restart that could not be
 * carried out stays booked, so the next pass tries again - the one thing that must
 * not happen is a request quietly disappearing while the server keeps running the
 * old settings.
 *
 * @param playersOnline - How many are on, or null when the server could not be
 *   asked. Null is not empty, and a server nobody can reach is not restarted on
 *   that basis.
 */
export async function runDueRestart(
    ownerId: string,
    installedAppId: string,
    playersOnline: number | null
): Promise<boolean> {
    const install = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, applicationId: true, catalogId: true }
    });
    if (!install?.applicationId) return false;
    const pending = readPendingRestart(readInstallConfig(install.config));
    if (!restartDue(pending, new Date(), playersOnline)) return false;
    try {
        await saveWorld(ownerId, installedAppId, install.catalogId);
        await deployApplication(install.applicationId, ownerId, pending?.requestedBy || ownerId);
        await patchInstallConfig(installedAppId, { [PENDING_RESTART_KEY]: null });
        // Imported here rather than at the top: this module is pulled in by the
        // schedule sweep, and the audit trail drags the whole session and
        // configuration stack in behind it.
        const { recordAudit } = await import("@/lib/audit-service");
        await recordAudit({
            actorId: pending?.requestedBy || ownerId,
            action: "games.restart.scheduled",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { when: pending?.when ?? "", reason: pending?.reason ?? "" }
        });
        return true;
    } catch {
        // Left booked on purpose. A server that could not be restarted now is one
        // that still needs restarting.
        return false;
    }
}

/** Write the world to disk before the server goes down, in whichever game's own
 *  words. Failure is not fatal: a server that is up but not answering still has to
 *  be restartable, and that is exactly the state somebody is trying to get out of. */
async function saveWorld(ownerId: string, installedAppId: string, catalogId: string): Promise<void> {
    if (gameOfServer(catalogId)?.id === "ark") {
        const { saveArkWorld } = await import("@/lib/apps/ark/service");
        await saveArkWorld(ownerId, installedAppId).catch(() => undefined);
        return;
    }
    const { runServerCommand } = await import("@/lib/apps/minecraft/service");
    await runServerCommand(ownerId, installedAppId, ["save-all", "flush"]).catch(() => undefined);
}
