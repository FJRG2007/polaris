/**
 * Granting, lifting and sweeping the timeouts.
 *
 * Split from `timeout.ts` because everything here reaches the server - the game's
 * own ban command and the install's config row - and the players table that reads
 * a timeout runs in the browser.
 *
 * Sweeping is deliberately not left to the cron alone: an instance with no cron
 * configured would hand out timeouts that never end, so the players screen sweeps
 * whenever it is read, exactly as scheduled deletions run lazily when a connection
 * is browsed.
 *
 * Java only, because the ban it is built on is Java only - Bedrock has no ban
 * command at all.
 */

import { prisma } from "@polaris/db";
import { runServerCommand } from "./service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { readTimeouts, TIMEOUTS_KEY, type PlayerTimeout } from "./timeout";

/**
 * Ban a player until a moment, and write down when that is.
 *
 * The ban goes first: if the server refuses it there is nothing to lift later,
 * and a note of a ban that was never applied would have the screen reporting
 * somebody as excluded who is still playing.
 */
export async function timeoutPlayer(
    ownerId: string,
    installedAppId: string,
    player: string,
    minutes: number,
    reason?: string
): Promise<PlayerTimeout> {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    await runServerCommand(ownerId, installedAppId, [
        "ban",
        player,
        reason && reason.length > 0 ? reason : `Timed out for ${minutes} minutes`
    ]);
    const entry = { player, until };
    const kept = (await readPlayerTimeouts(installedAppId)).filter(
        (held) => held.player.toLowerCase() !== player.toLowerCase()
    );
    await patchInstallConfig(installedAppId, { [TIMEOUTS_KEY]: [...kept, entry] });
    return entry;
}

/** Lift one early, or forget a note whose ban an operator has already pardoned by
 *  hand. Both are the same act to whoever is asking. */
export async function liftTimeout(ownerId: string, installedAppId: string, player: string): Promise<void> {
    await runServerCommand(ownerId, installedAppId, ["pardon", player]).catch(() => undefined);
    const kept = (await readPlayerTimeouts(installedAppId)).filter(
        (held) => held.player.toLowerCase() !== player.toLowerCase()
    );
    await patchInstallConfig(installedAppId, { [TIMEOUTS_KEY]: kept });
}

/**
 * Lift every timeout that has run out, and report how many that was.
 *
 * Best effort per player: a server that is not answering keeps its notes and is
 * swept again next time, because forgetting the note would leave the ban on
 * forever - the failure this whole file exists to prevent.
 */
export async function sweepTimeouts(ownerId: string, installedAppId: string): Promise<number> {
    const held = await readPlayerTimeouts(installedAppId);
    const now = Date.now();
    const due = held.filter((entry) => Date.parse(entry.until) <= now);
    if (due.length === 0) return 0;
    const lifted: string[] = [];
    for (const entry of due) {
        const pardoned = await runServerCommand(ownerId, installedAppId, ["pardon", entry.player])
            .then(() => true)
            .catch(() => false);
        if (pardoned) lifted.push(entry.player.toLowerCase());
    }
    if (lifted.length === 0) return 0;
    await patchInstallConfig(installedAppId, {
        [TIMEOUTS_KEY]: held.filter((entry) => !lifted.includes(entry.player.toLowerCase()))
    });
    return lifted.length;
}

/**
 * The timeouts on one server, from its own record.
 *
 * Always re-read rather than taken from a caller's copy: one is written from a
 * screen while the cron sweeps from somewhere else, and a stale list would
 * resurrect a note that had just been lifted.
 */
export async function readPlayerTimeouts(installedAppId: string): Promise<PlayerTimeout[]> {
    const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
    return readTimeouts(readInstallConfig(row?.config));
}
